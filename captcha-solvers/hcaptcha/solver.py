#!/usr/bin/env python3
"""
hCaptcha 解决器 - 使用原始 hcaptcha-challenger 库
只作为中间件，不修改原始代码
"""
import asyncio
import json
import sys
import os
import random
from pathlib import Path
from dotenv import load_dotenv
from playwright.async_api import async_playwright

# 加载根目录的统一配置文件
root_dir = Path(__file__).parent.parent.parent
env_path = root_dir / '.env'
load_dotenv(env_path, override=True)  # 强制覆盖现有环境变量

# 根据配置设置日志级别
log_level = os.getenv('PYTHON_LOG_LEVEL', 'CRITICAL')
import logging
if log_level == 'CRITICAL':
    logging.disable(logging.CRITICAL)
else:
    logging.basicConfig(level=getattr(logging, log_level.upper()))

# 禁用loguru日志 (如果配置为CRITICAL)
try:
    from loguru import logger
    if log_level == 'CRITICAL':
        logger.remove()
        logger.add(lambda _: None)  # 禁用所有输出
except ImportError:
    pass

from hcaptcha_challenger import AgentV, AgentConfig

def get_random_gemini_api_key():
    """
    从配置中随机选择一个Gemini API密钥
    """
    # 优先使用多个密钥配置
    api_keys_str = os.getenv('GEMINI_API_KEYS')
    if api_keys_str:
        api_keys = [key.strip() for key in api_keys_str.split(',') if key.strip()]
        if api_keys:
            selected_key = random.choice(api_keys)
            print(f"🔑 从{len(api_keys)}个API密钥中随机选择了一个密钥 (末尾: ...{selected_key[-8:]})")
            return selected_key
    
    # 如果没有配置多个密钥，使用单个密钥
    single_key = os.getenv('GEMINI_API_KEY')
    if single_key:
        print(f"🔑 使用单个API密钥 (末尾: ...{single_key[-8:]})")
        return single_key
    
    # 没有配置任何密钥
    raise ValueError("未配置任何Gemini API密钥。请设置GEMINI_API_KEY或GEMINI_API_KEYS环境变量")

async def click_hcaptcha_checkbox(page, agent):
    """Click hCaptcha checkbox with broad selector fallback."""
    selectors = [
        'iframe[src*="frame=checkbox"]',
        'iframe[src*="checkbox"]',
        'iframe[src*="newassets.hcaptcha.com"]',
        'iframe[src*="hcaptcha.com"]'
    ]

    for selector in selectors:
        try:
            iframe = page.locator(selector).first
            await iframe.wait_for(state='visible', timeout=8000)
            box = await iframe.bounding_box()
            if box:
                await page.mouse.click(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2, delay=150)
                await page.wait_for_timeout(1000)
                return True
        except Exception:
            pass

    # fallback to upstream robotic arm selector
    try:
        await agent.robotic_arm.click_checkbox()
        await page.wait_for_timeout(1000)
        return True
    except Exception as err:
        raise RuntimeError(f"failed to click hCaptcha checkbox: {err}")

async def solve_hcaptcha(website_url: str, website_key: str, proxy: str = None):
    """
    使用 hcaptcha-challenger 自动解决验证码。
    流程：打开页面 -> 等待/兜底渲染 hCaptcha -> 点击 checkbox -> 等待并自动识别挑战 -> 提取 token。
    """
    browser = None
    try:
        async with async_playwright() as p:
            launch_options = {
                "headless": os.getenv("HCAPTCHA_HEADLESS", "false").lower() == "true",
                "args": [
                    "--no-sandbox",
                    "--disable-setuid-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-blink-features=AutomationControlled"
                ]
            }

            if proxy:
                launch_options["proxy"] = {"server": proxy}

            browser = await p.chromium.launch(**launch_options)
            context = await browser.new_context(
                viewport={"width": 1366, "height": 768},
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36"
            )
            page = await context.new_page()

            # API key 必须在 AgentConfig 创建前写入环境变量，否则配置对象读不到随机选择的 key。
            selected_api_key = get_random_gemini_api_key()
            os.environ['GEMINI_API_KEY'] = selected_api_key

            agent_config = AgentConfig(
                GEMINI_API_KEY=selected_api_key,
                DISABLE_BEZIER_TRAJECTORY=os.getenv('DISABLE_BEZIER_TRAJECTORY', 'false').lower() == 'true',
                EXECUTION_TIMEOUT=float(os.getenv('HCAPTCHA_EXECUTION_TIMEOUT', os.getenv('HCAPTCHA_SOLVER_TIMEOUT', '300000'))) / 1000,
                RESPONSE_TIMEOUT=float(os.getenv('HCAPTCHA_RESPONSE_TIMEOUT', '60000')) / 1000,
                WAIT_FOR_CHALLENGE_VIEW_TO_RENDER_MS=int(os.getenv('HCAPTCHA_CHALLENGE_RENDER_WAIT_MS', '2000')),
                RETRY_ON_FAILURE=True,
            )

            # Agent 必须在触发 hCaptcha 前创建，这样才能监听 /getcaptcha/ 和 /checkcaptcha/ 响应。
            agent = AgentV(page=page, agent_config=agent_config)

            page_timeout = int(os.getenv('HCAPTCHA_PAGE_TIMEOUT', '30000'))
            await page.goto(website_url, wait_until='domcontentloaded', timeout=page_timeout)
            await page.wait_for_timeout(1500)

            # 等待目标页自身渲染 hCaptcha；如果没有，则用 websiteKey 兜底渲染一个 hCaptcha 容器。
            has_hcaptcha = await page.locator('iframe[src*="hcaptcha.com"], iframe[src*="newassets.hcaptcha.com"], .h-captcha, [data-sitekey]').count()
            if not has_hcaptcha:
                await page.evaluate(
                    """
                    async ({ sitekey }) => {
                        let container = document.querySelector('#codex-hcaptcha-container');
                        if (!container) {
                            container = document.createElement('div');
                            container.id = 'codex-hcaptcha-container';
                            container.style.cssText = 'position:relative;z-index:2147483647;margin:40px;';
                            const widget = document.createElement('div');
                            widget.className = 'h-captcha';
                            widget.setAttribute('data-sitekey', sitekey);
                            container.appendChild(widget);
                            document.body.prepend(container);
                        }
                        if (!document.querySelector('script[src*="hcaptcha.com/1/api.js"]')) {
                            await new Promise((resolve, reject) => {
                                const script = document.createElement('script');
                                script.src = 'https://js.hcaptcha.com/1/api.js';
                                script.async = true;
                                script.defer = true;
                                script.onload = resolve;
                                script.onerror = reject;
                                document.head.appendChild(script);
                            });
                        }
                    }
                    """,
                    {"sitekey": website_key}
                )
                await page.wait_for_timeout(3000)

            await page.wait_for_selector('iframe[src*="hcaptcha.com"], iframe[src*="newassets.hcaptcha.com"]', timeout=30000)

            # 点击 checkbox 触发挑战，hcaptcha-challenger 会在 wait_for_challenge 中自动识别图片并提交。
            await click_hcaptcha_checkbox(page, agent)
            signal = await agent.wait_for_challenge()

            # 优先从页面隐藏 textarea 获取真实 token。
            token = await page.evaluate(
                """
                () => {
                    const selectors = [
                        'textarea[name="h-captcha-response"]',
                        'textarea[name="g-recaptcha-response"]',
                        'input[name="h-captcha-response"]',
                        'input[name="g-recaptcha-response"]'
                    ];
                    for (const selector of selectors) {
                        const el = document.querySelector(selector);
                        if (el && el.value && el.value.length > 20) return el.value;
                    }
                    if (window.hcaptcha && typeof window.hcaptcha.getResponse === 'function') {
                        const value = window.hcaptcha.getResponse();
                        if (value && value.length > 20) return value;
                    }
                    return null;
                }
                """
            )

            if not token and agent.cr_list:
                cr = agent.cr_list[-1]
                response_data = cr.model_dump(by_alias=True)
                if 'generated_pass_UUID' in response_data:
                    token = response_data['generated_pass_UUID']
                elif 'c' in response_data and response_data['c'] and 'req' in response_data['c']:
                    token = response_data['c']['req']

            await browser.close()

            if token:
                return {
                    "code": 200,
                    "message": "hCaptcha solved successfully",
                    "token": token,
                    "challengeSignal": str(signal)
                }

            return {
                "code": 500,
                "message": f"hCaptcha challenge finished but no token was extracted; signal={signal}",
                "token": None
            }

    except Exception as e:
        try:
            if browser:
                await browser.close()
        except Exception:
            pass
        return {
            "code": 500,
            "message": f"Error: {str(e)}",
            "token": None
        }

async def main():
    """主函数"""
    try:
        if len(sys.argv) < 2:
            result = {
                "code": 400,
                "message": "Usage: python solver.py '{\"websiteUrl\":\"...\",\"websiteKey\":\"...\",\"proxy\":\"...\"}'",
                "token": None
            }
            print(json.dumps(result))
            return
        
        params = json.loads(sys.argv[1])
        website_url = params.get('websiteUrl')
        website_key = params.get('websiteKey')
        proxy = params.get('proxy')
        
        if not website_url or not website_key:
            result = {
                "code": 400,
                "message": "Missing required parameters: websiteUrl and websiteKey",
                "token": None
            }
            print(json.dumps(result))
            return
        
        result = await solve_hcaptcha(website_url, website_key, proxy)
        print(json.dumps(result))
        
    except json.JSONDecodeError:
        result = {
            "code": 400,
            "message": "Invalid JSON parameters",
            "token": None
        }
        print(json.dumps(result))
    except Exception as e:
        result = {
            "code": 500,
            "message": f"Unexpected error: {str(e)}",
            "token": None
        }
        print(json.dumps(result))

if __name__ == "__main__":
    asyncio.run(main())
