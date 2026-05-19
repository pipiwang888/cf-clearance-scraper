/**
 * reCAPTCHA v3 解决器
 * 专注于 token 提取和评分监控
 */

const { RecaptchaNotFoundError, RecaptchaSolveError } = require('../common/errors');

class RecaptchaV3Solver {
  constructor() {
    this.minScore = 0.5; // 最低可接受分数
    this.maxWaitTime = 30000; // 最大等待时间
  }

  async _cleanAdFrames(page) {
    try {
      await page.evaluate(() => {
        const adPatterns = [
          'google_vignette',
          'googlesyndication',
          'googleads',
          'doubleclick',
          'adservice.google',
          'pagead',
          'ad_iframe',
          'adsbygoogle',
          'securepubads'
        ];
        const isAdText = value => {
          const text = String(value || '').toLowerCase();
          return adPatterns.some(pattern => text.includes(pattern)) ||
            text.includes('advertisement') ||
            text.includes('google-auto-placed');
        };
        for (const iframe of document.querySelectorAll('iframe')) {
          if (isAdText(iframe.src) || isAdText(`${iframe.id || ''} ${iframe.className || ''}`)) {
            iframe.remove();
          }
        }
        for (const el of document.querySelectorAll('[id], [class], ins.adsbygoogle')) {
          if (isAdText(`${el.id || ''} ${el.className || ''}`)) {
            el.remove();
          }
        }
        document.documentElement.style.overflow = 'auto';
        if (document.body) document.body.style.overflow = 'auto';
      });
    } catch (e) {}
  }

  async _waitForPageReady(page, timeout = 120000) {
    const started = Date.now();
    let lastState = null;

    while (Date.now() - started < timeout) {
      await this._cleanAdFrames(page);
      lastState = await page.evaluate(() => {
        const html = document.documentElement.innerHTML;
        const title = document.title || '';
        const frames = [...document.querySelectorAll('iframe')].map(f => f.src || '');
        const hasCf = title.includes('Just a moment') ||
          html.includes('cf_chl') ||
          html.includes('cf_chl_opt') ||
          html.includes('challenges.cloudflare.com') ||
          frames.some(src => src.includes('challenges.cloudflare.com'));
        const hasRecaptcha = html.includes('google.com/recaptcha') ||
          html.includes('recaptcha.net/recaptcha') ||
          html.includes('g-recaptcha') ||
          html.includes('grecaptcha') ||
          frames.some(src => src.includes('google.com/recaptcha') || src.includes('recaptcha.net/recaptcha'));
        return { title, url: location.href, hasCf, hasRecaptcha, frameCount: frames.length };
      }).catch(error => ({ title: '', url: '', hasCf: true, hasRecaptcha: false, frameCount: 0, error: error.message }));

      if (!lastState.hasCf) {
        console.log(`✅ 页面已通过前置验证: recaptcha=${lastState.hasRecaptcha}, frames=${lastState.frameCount}`);
        return lastState;
      }

      console.log(`⏳ 等待 Cloudflare/广告结束: cf=${lastState.hasCf}, recaptcha=${lastState.hasRecaptcha}, title="${lastState.title}"`);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }

    throw new Error(`等待 Cloudflare/广告结束超时: ${JSON.stringify(lastState)}`);
  }

  /**
   * 解决 reCAPTCHA v3 验证码
   */
  async solve(page, options = {}) {
    const {
      url = null,
      action = 'submit',
      timeout = this.maxWaitTime,
      sitekey = null
    } = options;

    console.log('🤖 开始 reCAPTCHA v3 解决流程...');
    console.log(`⚙️  配置: 动作=${action}, 超时=${timeout}ms`);

    const startTime = Date.now();
    const tokens = [];
    const scores = [];

    // 1. 在导航页面之前就设置网络监听器（关键！）
    const responseHandler = async (response) => {
      const url = response.url();
      
      // 监听 reCAPTCHA API 响应
      if (url.includes('recaptcha/api2/reload') || url.includes('recaptcha/enterprise/reload') || url.includes('recaptcha/api2/userverify')) {
        try {
          const text = await response.text();
          console.log(`🔍 捕获到 reCAPTCHA API 响应: ${url}`);
          
          // 使用更精确的 token 提取方法（参考原始实现）
          let tokenMatch = text.match(/"rresp","([^"]+)"/);
          if (!tokenMatch) {
            // 备用方法：提取长 token
            tokenMatch = text.match(/"([A-Za-z0-9_-]{100,})"/);
          }
          
          if (tokenMatch) {
            const token = tokenMatch[1];
            tokens.push(token);
            console.log(`🎯 捕获到 reCAPTCHA v3 token (长度: ${token.length})`);

            // 尝试提取分数
            const scoreMatch = text.match(/"score":([0-9.]+)/);
            if (scoreMatch) {
              const score = parseFloat(scoreMatch[1]);
              scores.push(score);
              console.log(`📊 Token 分数: ${score}`);
            } else {
              scores.push(0.5); // 默认分数
            }
          }
        } catch (error) {
          console.warn('解析 reCAPTCHA 响应时出错:', error.message);
        }
      }
    };

    page.on('response', responseHandler);

    try {
      // 2. 可选导航。response 监听器已注册，避免错过 reCAPTCHA reload 响应。
      if (url) {
        console.log(`🔗 导航到: ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(timeout, 45000) });
        await this._waitForPageReady(page, Math.max(timeout, 120000));
      }

      console.log('⏳ 等待页面加载...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // 注入模拟的 Web3 钱包环境
      console.log('💰 注入模拟钱包环境...');
      await this._injectWeb3Environment(page);
      
      // 3. 尝试等待 reCAPTCHA v3 脚本加载
      await this._ensureRecaptchaScript(page, sitekey);
      await this._waitForRecaptchaLoad(page, Math.min(timeout, 15000));

      // 4. 首先尝试直接执行 reCAPTCHA v3
      console.log(`🎯 尝试直接执行 reCAPTCHA v3 (动作: ${action})...`);
      const executeResult = await this._executeRecaptcha(page, action, sitekey);
      
      if (executeResult.token) {
        tokens.push(executeResult.token);
        if (executeResult.score !== undefined) {
          scores.push(executeResult.score);
        }
      }

      // 5. 如果直接执行没有获得 token，尝试交互触发
      if (tokens.length === 0) {
        console.log('🖱️  尝试通过用户交互触发 reCAPTCHA...');
        await this._triggerThroughInteraction(page, action, sitekey);
        
        // 等待网络捕获
        console.log('⏳ 等待网络捕获 reCAPTCHA token...');
        await this._waitForTokens(tokens, Math.min(timeout, 30000));
      }

      // 6. 选择最佳 token
      const bestToken = this._selectBestToken(tokens, scores);
      
      if (!bestToken) {
        throw new RecaptchaSolveError('No valid reCAPTCHA v3 token found');
      }

      const solveTime = Date.now() - startTime;
      console.log(`✅ reCAPTCHA v3 解决成功！`);
      console.log(`   Token长度: ${bestToken.token.length}`);
      console.log(`   分数: ${bestToken.score || 'unknown'}`);
      console.log(`   总耗时: ${solveTime}ms`);

      return {
        success: true,
        token: bestToken.token,
        score: bestToken.score,
        action: action,
        solveTime: solveTime
      };

    } catch (error) {
      const solveTime = Date.now() - startTime;
      console.error(`❌ reCAPTCHA v3 解决失败 (${solveTime}ms):`, error.message);
      
      throw new RecaptchaSolveError(`reCAPTCHA v3 solving failed after ${solveTime}ms: ${error.message}`);
    } finally {
      page.off('response', responseHandler);
    }
  }

  /**
   * 等待 reCAPTCHA 脚本加载
   */
  async _waitForRecaptchaLoad(page, timeout) {
    console.log('⏳ 等待 reCAPTCHA v3 脚本加载...');
    
    try {
      // 等待更短的时间，如果没有加载就跳过
      await page.waitForFunction(
        () => window.grecaptcha && window.grecaptcha.execute,
        { timeout: Math.min(timeout, 10000) }
      );
      console.log('✅ reCAPTCHA v3 脚本已加载');
    } catch (error) {
      console.log('⚠️  reCAPTCHA v3 脚本未在预期时间内加载，继续尝试...');
      // 不抛出错误，继续执行
    }
  }

  /**
   * 如果页面没有主动加载 reCAPTCHA v3 脚本，则按传入 sitekey 注入官方 api.js。
   */
  async _ensureRecaptchaScript(page, sitekey) {
    if (!sitekey) return;

    try {
      const state = await page.evaluate((sitekey) => {
        const hasRecaptcha =
          Boolean(window.grecaptcha) ||
          [...document.scripts].some((s) => s.src && s.src.includes('google.com/recaptcha'));

        if (hasRecaptcha) {
          return { injected: false, reason: 'already_present' };
        }

        const script = document.createElement('script');
        script.src = `https://www.google.com/recaptcha/api.js?render=${encodeURIComponent(sitekey)}`;
        script.async = true;
        script.defer = true;
        document.head.appendChild(script);
        return { injected: true };
      }, sitekey);

      if (state.injected) {
        console.log('✅ 已注入 reCAPTCHA v3 api.js');
      }
    } catch (error) {
      console.warn('⚠️  注入 reCAPTCHA 脚本失败:', error.message);
    }
  }

  /**
   * 执行 reCAPTCHA v3
   */
  async _executeRecaptcha(page, action, sitekey) {
    console.log(`🎯 执行 reCAPTCHA v3 (动作: ${action})...`);

    try {
      const result = await page.evaluate(async (action, sitekey) => {
        try {
          // 等待 grecaptcha 可用
          let retries = 0;
          while (!window.grecaptcha && retries < 30) {
            await new Promise(resolve => setTimeout(resolve, 500));
            retries++;
          }

          if (!window.grecaptcha) {
            return { error: 'grecaptcha not available after waiting' };
          }

          // 方法1: 使用指定的 sitekey
          if (sitekey && window.grecaptcha.execute) {
            console.log(`尝试使用指定的 sitekey: ${sitekey}`);
            const token = await window.grecaptcha.execute(sitekey, { action });
            return { token, method: 'specified_sitekey', sitekey };
          }

          // 方法2: 查找页面中的 sitekey
          const elements = document.querySelectorAll('[data-sitekey]');
          for (const element of elements) {
            const foundSitekey = element.getAttribute('data-sitekey');
            if (foundSitekey && foundSitekey.startsWith('6L')) {
              console.log(`尝试使用 DOM 中的 sitekey: ${foundSitekey}`);
              try {
                const token = await window.grecaptcha.execute(foundSitekey, { action });
                return { token, sitekey: foundSitekey, method: 'dom_sitekey' };
              } catch (e) {
                console.log(`DOM sitekey ${foundSitekey} 执行失败:`, e.message);
                continue;
              }
            }
          }

          // 方法3: 查找脚本中的 sitekey
          const scripts = document.querySelectorAll('script');
          for (const script of scripts) {
            const content = script.textContent || script.innerHTML;
            const sitekeyMatches = content.match(/6L[0-9a-zA-Z_-]{39}/g);
            
            if (sitekeyMatches) {
              for (const foundSitekey of sitekeyMatches) {
                console.log(`尝试使用脚本中的 sitekey: ${foundSitekey}`);
                try {
                  const token = await window.grecaptcha.execute(foundSitekey, { action });
                  return { token, sitekey: foundSitekey, method: 'script_sitekey' };
                } catch (e) {
                  console.log(`脚本 sitekey ${foundSitekey} 执行失败:`, e.message);
                  continue;
                }
              }
            }
          }

          // 方法4: 尝试触发任何现有的 reCAPTCHA 
          if (window.grecaptcha.ready) {
            return new Promise((resolve) => {
              window.grecaptcha.ready(() => {
                // 查找可能的触发按钮
                const buttons = document.querySelectorAll('button, input[type="submit"], [role="button"]');
                for (const button of buttons) {
                  const text = button.textContent?.toLowerCase() || '';
                  if (text.includes('submit') || text.includes('login') || text.includes('sign')) {
                    console.log(`尝试点击按钮触发验证: ${text}`);
                    button.click();
                    break;
                  }
                }
                
                // 等待一下看是否有响应
                setTimeout(() => {
                  resolve({ error: 'No automatic trigger found' });
                }, 2000);
              });
            });
          }

          return { error: 'No valid sitekey found and no automatic trigger' };
        } catch (error) {
          return { error: error.message };
        }
      }, action, sitekey);

      if (result.error) {
        console.warn(`⚠️  执行失败: ${result.error}`);
        return {};
      }

      if (result.token) {
        console.log(`✅ 成功执行 reCAPTCHA v3 (方法: ${result.method})`);
        console.log(`🔑 使用的 sitekey: ${result.sitekey}`);
      }

      return result;
    } catch (error) {
      console.warn(`⚠️  直接执行失败: ${error.message}`);
      return {};
    }
  }

  /**
   * 注入 Web3 钱包环境
   */
  async _injectWeb3Environment(page) {
    try {
      await page.evaluate(() => {
        // 模拟 MetaMask
        if (!window.ethereum) {
          window.ethereum = {
            isMetaMask: true,
            isConnected: () => true,
            chainId: '0x1', // Ethereum mainnet
            networkVersion: '1',
            selectedAddress: '0x742d35Cc6634C0532925a3b8D1D8ceb72a28B72d',
            
            request: async ({ method, params }) => {
              console.log(`模拟钱包请求: ${method}`, params);
              
              switch (method) {
                case 'eth_requestAccounts':
                case 'eth_accounts':
                  return ['0x742d35Cc6634C0532925a3b8D1D8ceb72a28B72d'];
                
                case 'eth_chainId':
                  return '0x1';
                
                case 'eth_getBalance':
                  return '0x1bc16d674ec80000'; // 2 ETH
                
                case 'wallet_requestPermissions':
                  return [{ parentCapability: 'eth_accounts' }];
                
                case 'wallet_getPermissions':
                  return [{ parentCapability: 'eth_accounts' }];
                
                case 'personal_sign':
                  return '0x' + '0'.repeat(130); // 模拟签名
                
                default:
                  throw new Error(`Unsupported method: ${method}`);
              }
            },
            
            on: (event, handler) => {
              console.log(`监听事件: ${event}`);
            },
            
            removeListener: (event, handler) => {
              console.log(`移除监听: ${event}`);
            },
            
            // 触发连接事件
            _triggerConnect: () => {
              if (window.ethereum._eventHandlers?.connect) {
                window.ethereum._eventHandlers.connect({
                  chainId: '0x1'
                });
              }
            }
          };
          
          // 触发各种 Web3 事件
          setTimeout(() => {
            window.dispatchEvent(new Event('ethereum#initialized'));
            
            // 触发钱包连接事件
            if (window.ethereum._triggerConnect) {
              window.ethereum._triggerConnect();
            }
          }, 500);
          
          console.log('✅ 已注入模拟 MetaMask 钱包');
        }
        
        // 模拟其他常见钱包
        if (!window.web3) {
          window.web3 = {
            currentProvider: window.ethereum,
            eth: {
              accounts: ['0x742d35Cc6634C0532925a3b8D1D8ceb72a28B72d']
            }
          };
        }
        
        // 模拟 WalletConnect
        if (!window.WalletConnectProvider) {
          window.WalletConnectProvider = class {
            constructor() {
              this.connected = true;
              this.accounts = ['0x742d35Cc6634C0532925a3b8D1D8ceb72a28B72d'];
              this.chainId = 1;
            }
            
            async enable() {
              return this.accounts;
            }
          };
        }
      });
      
      console.log('✅ Web3 环境注入完成');
    } catch (error) {
      console.warn('⚠️  Web3 环境注入失败:', error.message);
    }
  }

  /**
   * 通过用户交互触发 reCAPTCHA v3
   */
  async _triggerThroughInteraction(page, action, sitekey) {
    try {
      console.log('🔍 分析页面，寻找触发元素...');
      
      const interactionResult = await page.evaluate(async (action, sitekey) => {
        const interactions = [];
        
        // 1. 查找登录/提交按钮
        const loginButtons = [];
        
        // 基本按钮选择器
        const basicButtons = document.querySelectorAll('button[type="submit"], input[type="submit"]');
        loginButtons.push(...basicButtons);
        
        // 按类名查找
        const classButtons = document.querySelectorAll('[class*="login"], [class*="submit"], [class*="Login"], [class*="Submit"]');
        loginButtons.push(...classButtons);
        
        // 按ID查找
        const idButtons = document.querySelectorAll('[id*="login"], [id*="submit"], [id*="Login"], [id*="Submit"]');
        loginButtons.push(...idButtons);
        
        // 按文本内容查找 (包含 Web3 相关关键词)
        const allButtons = document.querySelectorAll('button, [role="button"], input[type="button"]');
        for (const button of allButtons) {
          const text = (button.textContent || button.value || '').toLowerCase();
          if (text.includes('login') || text.includes('sign in') || text.includes('submit') || 
              text.includes('log in') || text.includes('sign-in') || text.includes('signin') ||
              // Web3 相关关键词
              text.includes('connect') || text.includes('wallet') || text.includes('metamask') ||
              text.includes('connect wallet') || text.includes('link wallet') || 
              text.includes('verify') || text.includes('authenticate') || text.includes('continue') ||
              text.includes('proceed') || text.includes('next') || text.includes('confirm') ||
              // 加密货币相关
              text.includes('stake') || text.includes('claim') || text.includes('mint') ||
              text.includes('swap') || text.includes('trade') || text.includes('bridge') ||
              // 其他常见触发词
              text.includes('start') || text.includes('begin') || text.includes('launch') ||
              text.includes('access') || text.includes('enter') || text.includes('join')) {
            loginButtons.push(button);
          }
        }
        
        // 去重
        const uniqueLoginButtons = [...new Set(loginButtons)];
        
        // 2. 查找表单
        const forms = document.querySelectorAll('form');
        
        console.log(`找到 ${uniqueLoginButtons.length} 个登录按钮, ${forms.length} 个表单`);
        
        // 记录找到的按钮信息
        uniqueLoginButtons.forEach((btn, i) => {
          const text = (btn.textContent || btn.value || '').trim();
          const className = btn.className || '';
          const id = btn.id || '';
          console.log(`按钮 ${i}: "${text}" (class: ${className}, id: ${id})`);
        });
        
        // 4. 尝试填写任何必需的表单字段
        const emailInputs = document.querySelectorAll('input[type="email"], input[name*="email"], input[id*="email"]');
        const passwordInputs = document.querySelectorAll('input[type="password"], input[name*="password"], input[id*="password"]');
        
        for (const emailInput of emailInputs) {
          if (emailInput.value === '') {
            emailInput.value = 'test@example.com';
            emailInput.dispatchEvent(new Event('input', { bubbles: true }));
            emailInput.dispatchEvent(new Event('change', { bubbles: true }));
            interactions.push(`填写邮箱: ${emailInput.name || emailInput.id}`);
          }
        }
        
        for (const passwordInput of passwordInputs) {
          if (passwordInput.value === '') {
            passwordInput.value = 'testpassword123';
            passwordInput.dispatchEvent(new Event('input', { bubbles: true }));
            passwordInput.dispatchEvent(new Event('change', { bubbles: true }));
            interactions.push(`填写密码: ${passwordInput.name || passwordInput.id}`);
          }
        }
        
        // 5. 尝试点击按钮触发验证
        for (const button of uniqueLoginButtons) {
          if (!button.disabled) {
            try {
              console.log(`尝试点击按钮: ${button.textContent?.trim() || button.value || button.className}`);
              
              // 先尝试执行 reCAPTCHA（如果可能）
              if (window.grecaptcha && window.grecaptcha.execute && sitekey) {
                try {
                  const token = await window.grecaptcha.execute(sitekey, { action });
                  if (token) {
                    interactions.push(`成功执行 reCAPTCHA: ${token.substring(0, 20)}...`);
                    return { success: true, token, interactions };
                  }
                } catch (e) {
                  console.log('执行 reCAPTCHA 失败:', e.message);
                }
              }
              
              // 点击按钮
              button.click();
              interactions.push(`点击按钮: ${button.textContent?.trim() || button.className}`);
              
              // 等待一下看是否触发了 reCAPTCHA
              await new Promise(resolve => setTimeout(resolve, 2000));
              
              break; // 只点击第一个找到的按钮
            } catch (e) {
              console.log(`点击按钮失败: ${e.message}`);
            }
          }
        }
        
        // 6. 如果没有找到特定按钮，启用智能元素检测
        if (uniqueLoginButtons.length === 0) {
          console.log('🔍 启用智能元素检测模式...');
          
          // 智能元素检测函数
          const smartElementDetection = async () => {
            const results = [];
            
            // 1. 分析所有输入框的上下文
            const inputs = document.querySelectorAll('input, textarea');
            const inputGroups = [];
            
            inputs.forEach(input => {
              const group = {
                element: input,
                type: input.type || 'text',
                name: input.name || '',
                id: input.id || '',
                placeholder: input.placeholder || '',
                label: '',
                nearbyButtons: []
              };
              
              // 查找关联的 label
              if (input.id) {
                const label = document.querySelector(`label[for="${input.id}"]`);
                if (label) group.label = label.textContent?.trim() || '';
              }
              
              // 查找父元素中的 label
              let parent = input.parentElement;
              for (let i = 0; i < 3 && parent; i++) {
                const label = parent.querySelector('label');
                if (label && !group.label) {
                  group.label = label.textContent?.trim() || '';
                  break;
                }
                parent = parent.parentElement;
              }
              
              // 查找附近的按钮 (在同一个容器内)
              parent = input.parentElement;
              for (let i = 0; i < 5 && parent; i++) {
                const buttons = parent.querySelectorAll('button, input[type="button"], input[type="submit"]');
                buttons.forEach(btn => {
                  if (!group.nearbyButtons.includes(btn)) {
                    group.nearbyButtons.push(btn);
                  }
                });
                parent = parent.parentElement;
              }
              
              inputGroups.push(group);
            });
            
            // 2. 智能分析并填写表单
            for (const group of inputGroups) {
              const { element, type, name, id, placeholder, label } = group;
              const context = `${name} ${id} ${placeholder} ${label}`.toLowerCase();
              
              // 邮箱字段
              if (type === 'email' || context.includes('email') || context.includes('mail')) {
                if (!element.value) {
                  element.value = 'test@example.com';
                  element.dispatchEvent(new Event('input', { bubbles: true }));
                  element.dispatchEvent(new Event('change', { bubbles: true }));
                  element.dispatchEvent(new Event('blur', { bubbles: true }));
                  results.push({ description: `填写邮箱字段: ${element.name || element.id}` });
                  
                  // 等待一下让验证生效
                  await new Promise(resolve => setTimeout(resolve, 1000));
                  
                  // 检查是否有按钮变为可用
                  const nearbyButtons = group.nearbyButtons;
                  for (const btn of nearbyButtons) {
                    if (btn.disabled === false && btn.offsetParent !== null) {
                      const btnText = (btn.textContent || btn.value || '').toLowerCase();
                      if (btnText.includes('start') || btnText.includes('submit') || btnText.includes('continue')) {
                        try {
                          btn.click();
                          results.push({ description: `点击已启用的按钮: ${btn.textContent?.trim() || btn.value}` });
                        } catch (e) {
                          // 忽略点击错误
                        }
                      }
                    }
                  }
                }
              }
              
              // 密码字段
              else if (type === 'password' || context.includes('password') || context.includes('pass')) {
                if (!element.value) {
                  element.value = 'TestPassword123!';
                  element.dispatchEvent(new Event('input', { bubbles: true }));
                  element.dispatchEvent(new Event('change', { bubbles: true }));
                  results.push({ description: `填写密码字段: ${element.name || element.id}` });
                }
              }
              
              // 用户名字段
              else if (context.includes('user') || context.includes('name') || context.includes('login')) {
                if (!element.value) {
                  element.value = 'testuser';
                  element.dispatchEvent(new Event('input', { bubbles: true }));
                  element.dispatchEvent(new Event('change', { bubbles: true }));
                  results.push({ description: `填写用户名字段: ${element.name || element.id}` });
                }
              }
              
              // 电话字段
              else if (type === 'tel' || context.includes('phone') || context.includes('tel')) {
                if (!element.value) {
                  element.value = '+1234567890';
                  element.dispatchEvent(new Event('input', { bubbles: true }));
                  element.dispatchEvent(new Event('change', { bubbles: true }));
                  results.push({ description: `填写电话字段: ${element.name || element.id}` });
                }
              }
              
              // 尝试点击附近的按钮
              for (const btn of group.nearbyButtons) {
                if (!btn.disabled && btn.offsetParent !== null) { // 确保按钮可见
                  try {
                    btn.click();
                    results.push({ description: `点击附近按钮: ${btn.textContent?.trim() || btn.value || btn.className}` });
                  } catch (e) {
                    // 忽略点击错误
                  }
                }
              }
            }
            
            // 3. 智能钱包连接检测（通过视觉特征而非关键词）
            const detectWalletButtons = () => {
              const walletButtons = [];
              const allClickableElements = document.querySelectorAll('button, [role="button"], div[onclick], a, [tabindex]');
              
              for (const element of allClickableElements) {
                if (!element.offsetParent) continue; // 跳过不可见元素
                
                const computedStyle = window.getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                
                // 检查是否包含图像或图标
                const hasImages = element.querySelectorAll('img, svg, [class*="icon"], [class*="logo"]').length > 0;
                const hasBackgroundImage = computedStyle.backgroundImage !== 'none';
                
                // 检查元素特征
                const isButtonLike = element.tagName === 'BUTTON' || 
                                   element.getAttribute('role') === 'button' ||
                                   computedStyle.cursor === 'pointer';
                
                // 检查尺寸（钱包按钮通常是方形或接近方形）
                const isSquareish = rect.width > 30 && rect.height > 30 && 
                                  Math.abs(rect.width - rect.height) < Math.max(rect.width, rect.height) * 0.5;
                
                // 检查是否在合适的位置（通常在页面上部或中部）
                const isInGoodPosition = rect.top < window.innerHeight * 0.8;
                
                // 钱包按钮检测逻辑
                if (isButtonLike && isInGoodPosition && (hasImages || hasBackgroundImage || isSquareish)) {
                  // 额外检查：是否有 MetaMask 橙色特征
                  const bgColor = computedStyle.backgroundColor;
                  const isOrangeish = bgColor.includes('rgb(255, 102, 0)') || 
                                    bgColor.includes('rgb(245, 131, 50)') ||
                                    bgColor.includes('#ff6600') ||
                                    bgColor.includes('#f58332');
                  
                  // 检查类名中是否有钱包相关的模式（不是关键词匹配，而是模式匹配）
                  const className = element.className.toLowerCase();
                  const hasWalletPattern = /wallet|metamask|connect|web3|crypto/i.test(className);
                  
                  // 检查子元素中是否有狐狸形状的SVG或特殊图标
                  const svgElements = element.querySelectorAll('svg');
                  const hasFoxLikeSvg = Array.from(svgElements).some(svg => {
                    const pathElements = svg.querySelectorAll('path');
                    return pathElements.length > 3; // MetaMask logo通常有多个path
                  });
                  
                  let confidence = 0;
                  if (hasImages) confidence += 20;
                  if (hasBackgroundImage) confidence += 15;
                  if (isSquareish) confidence += 10;
                  if (isOrangeish) confidence += 30;
                  if (hasWalletPattern) confidence += 25;
                  if (hasFoxLikeSvg) confidence += 20;
                  
                  if (confidence >= 25) {
                    walletButtons.push({
                      element: element,
                      confidence: confidence,
                      features: {
                        hasImages,
                        hasBackgroundImage,
                        isSquareish,
                        isOrangeish,
                        hasWalletPattern,
                        hasFoxLikeSvg
                      }
                    });
                  }
                }
              }
              
              // 按置信度排序
              return walletButtons.sort((a, b) => b.confidence - a.confidence);
            };
            
            const walletButtons = detectWalletButtons();
            console.log(`🦊 检测到 ${walletButtons.length} 个可能的钱包连接按钮`);
            
            for (const walletBtn of walletButtons.slice(0, 2)) { // 只尝试前2个最可能的
              try {
                console.log(`尝试点击钱包按钮 (置信度: ${walletBtn.confidence})`);
                walletBtn.element.click();
                results.push({ 
                  description: `点击钱包连接按钮 (置信度: ${walletBtn.confidence}, 特征: ${JSON.stringify(walletBtn.features)})` 
                });
                
                // 等待钱包连接响应
                await new Promise(resolve => setTimeout(resolve, 2000));
                
                // 检查是否出现了钱包连接界面或其他变化
                const hasModalOrPopup = document.querySelector('[role="dialog"], .modal, [class*="popup"], [class*="overlay"]');
                if (hasModalOrPopup) {
                  results.push({ description: '检测到钱包连接弹窗' });
                }
                
              } catch (e) {
                console.log(`钱包按钮点击失败: ${e.message}`);
              }
            }
            
            // 4. 检查并处理禁用的按钮（特别是 Magic Newton 这种需要填写邮箱才能启用的场景）
            const allButtons = document.querySelectorAll('button, [role="button"], input[type="button"], input[type="submit"]');
            const disabledButtons = Array.from(allButtons).filter(btn => 
              btn.offsetParent !== null && btn.disabled
            );
            
            // 查找禁用的重要按钮
            const importantDisabledButtons = disabledButtons.filter(btn => {
              const text = (btn.textContent || btn.value || '').toLowerCase();
              return text.includes('start') || text.includes('submit') || text.includes('continue') || 
                     text.includes('next') || text.includes('connect') || text.includes('login');
            });
            
            if (importantDisabledButtons.length > 0) {
              console.log(`发现 ${importantDisabledButtons.length} 个重要的禁用按钮，尝试启用...`);
              
              // 如果有禁用的重要按钮，寻找可能需要填写的邮箱字段
              const emailInputs = document.querySelectorAll('input[type="email"], input[placeholder*="email" i], input[aria-label*="email" i]');
              
              for (const emailInput of emailInputs) {
                if (!emailInput.value) {
                  console.log('填写邮箱字段以启用按钮...');
                  emailInput.value = 'test@example.com';
                  emailInput.dispatchEvent(new Event('input', { bubbles: true }));
                  emailInput.dispatchEvent(new Event('change', { bubbles: true }));
                  emailInput.dispatchEvent(new Event('blur', { bubbles: true }));
                  results.push({ description: `填写邮箱字段启用按钮: ${emailInput.placeholder || emailInput.name || emailInput.id}` });
                  
                  // 等待验证
                  await new Promise(resolve => setTimeout(resolve, 1500));
                  
                  // 重新检查按钮状态
                  for (const btn of importantDisabledButtons) {
                    if (!btn.disabled) {
                      try {
                        btn.click();
                        results.push({ description: `点击已启用的重要按钮: ${btn.textContent?.trim() || btn.value}` });
                        return results; // 成功点击，返回结果
                      } catch (e) {
                        // 忽略点击错误
                      }
                    }
                  }
                }
              }
            }
            
            // 5. 如果没有输入框或没有禁用按钮，尝试点击所有可见的启用按钮
            if (inputGroups.length === 0 && importantDisabledButtons.length === 0) {
              const visibleButtons = Array.from(allButtons).filter(btn => 
                btn.offsetParent !== null && !btn.disabled
              );
              
              // 按可能性排序按钮
              const sortedButtons = visibleButtons.sort((a, b) => {
                const aText = (a.textContent || a.value || '').toLowerCase();
                const bText = (b.textContent || b.value || '').toLowerCase();
                
                // 优先级关键词
                const highPriorityWords = ['connect', 'login', 'sign', 'submit', 'continue', 'next', 'start'];
                const aScore = highPriorityWords.some(word => aText.includes(word)) ? 1 : 0;
                const bScore = highPriorityWords.some(word => bText.includes(word)) ? 1 : 0;
                
                return bScore - aScore;
              });
              
              // 点击前3个最有可能的按钮
              for (const btn of sortedButtons.slice(0, 3)) {
                try {
                  btn.click();
                  results.push({ description: `智能点击按钮: ${btn.textContent?.trim() || btn.value || btn.className}` });
                } catch (e) {
                  // 忽略点击错误
                }
              }
            }
            
            return results;
          };
          
          const smartResults = await smartElementDetection();
          for (const result of smartResults) {
            interactions.push(`智能检测: ${result.description}`);
          }
        }
        
        // 7. 如果没有找到登录按钮，尝试提交表单
        if (uniqueLoginButtons.length === 0 && forms.length > 0) {
          for (const form of forms) {
            try {
              console.log('尝试提交表单');
              
              // 先尝试执行 reCAPTCHA
              if (window.grecaptcha && window.grecaptcha.execute && sitekey) {
                try {
                  const token = await window.grecaptcha.execute(sitekey, { action });
                  if (token) {
                    interactions.push(`表单提交前执行 reCAPTCHA: ${token.substring(0, 20)}...`);
                    return { success: true, token, interactions };
                  }
                } catch (e) {
                  console.log('表单提交前执行 reCAPTCHA 失败:', e.message);
                }
              }
              
              // 触发表单提交事件（不实际提交）
              const submitEvent = new Event('submit', { bubbles: true, cancelable: true });
              form.dispatchEvent(submitEvent);
              interactions.push('触发表单提交事件');
              
              await new Promise(resolve => setTimeout(resolve, 2000));
              break;
            } catch (e) {
              console.log(`表单操作失败: ${e.message}`);
            }
          }
        }
        
        return { success: false, interactions };
      }, action, sitekey);
      
      console.log('🔄 交互结果:', interactionResult.interactions);
      
      if (interactionResult.success && interactionResult.token) {
        console.log('✅ 通过交互成功获取 token');
        return interactionResult.token;
      }
      
      // 等待一段时间，让页面有机会触发 reCAPTCHA
      await new Promise(resolve => setTimeout(resolve, 5000));
      
    } catch (error) {
      console.warn('交互触发失败:', error.message);
    }
  }

  /**
   * 等待 tokens 收集
   */
  async _waitForTokens(tokens, timeout) {
    console.log('⏳ 等待 reCAPTCHA v3 tokens...');
    
    const startTime = Date.now();
    const checkInterval = 500;
    
    while (tokens.length === 0 && (Date.now() - startTime) < timeout) {
      await new Promise(resolve => setTimeout(resolve, checkInterval));
    }
  }

  /**
   * 选择最佳 token
   */
  _selectBestToken(tokens, scores) {
    if (tokens.length === 0) {
      return null;
    }

    // 如果只有一个 token，直接返回
    if (tokens.length === 1) {
      return {
        token: tokens[0],
        score: scores[0]
      };
    }

    // 选择分数最高的 token
    let bestIndex = 0;
    let bestScore = scores[0] || 0;

    for (let i = 1; i < tokens.length; i++) {
      const score = scores[i] || 0;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    console.log(`🎯 选择最佳 token (索引: ${bestIndex}, 分数: ${bestScore})`);

    return {
      token: tokens[bestIndex],
      score: bestScore
    };
  }

  /**
   * 验证 token 分数
   */
  _isValidScore(score) {
    return score >= this.minScore;
  }

  /**
   * 获取解决器统计信息
   */
  getStats() {
    return {
      solver: 'reCAPTCHA v3',
      version: '1.0.0',
      features: [
        'Automatic token extraction',
        'Network response monitoring',
        'Multiple sitekey detection methods',
        'Score-based token selection',
        'Action-based execution'
      ],
      minScore: this.minScore,
      maxWaitTime: this.maxWaitTime,
      supportedActions: [
        'submit',
        'login',
        'signup',
        'contact',
        'homepage'
      ]
    };
  }

  /**
   * 设置解决器选项
   */
  setOptions(options) {
    if (options.minScore !== undefined) {
      this.minScore = options.minScore;
    }
    if (options.maxWaitTime !== undefined) {
      this.maxWaitTime = options.maxWaitTime;
    }
    
    console.log(`⚙️  reCAPTCHA v3 选项已更新: 最低分数=${this.minScore}, 最大等待=${this.maxWaitTime}ms`);
  }

  /**
   * 验证环境依赖
   */
  async validateEnvironment() {
    console.log('✅ reCAPTCHA v3 无需额外环境依赖');
    return { valid: true, issues: [] };
  }
}

module.exports = RecaptchaV3Solver;
