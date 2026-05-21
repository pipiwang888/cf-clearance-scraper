/**
 * 简化的 reCAPTCHA v2 解决器
 * 基于 GoogleRecaptchaBypass 的思路，简化流程
 */

const NodeAudioProcessor = require('./common/nodeAudioProcessor');
const { RecaptchaNotFoundError, RecaptchaSolveError } = require('./common/errors');

class SimpleRecaptchaV2Solver {
  constructor() {
    this.audioProcessor = new NodeAudioProcessor();
    this.maxAttempts = 3;
  }

  async _sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  _isRecaptchaFrame(url = '') {
    return url.includes('google.com/recaptcha') || url.includes('recaptcha.net/recaptcha');
  }

  _isAdFrame(url = '') {
    return [
      'google_vignette',
      'googlesyndication',
      'googleads',
      'doubleclick',
      'adservice.google',
      'pagead',
      'adsbygoogle',
      'securepubads'
    ].some(pattern => url.includes(pattern));
  }

  /**
   * 解决 reCAPTCHA v2 - 简化流程
   */
  async solve(page, options = {}) {
    const { language = 'en-US', timeout = 120000, method = 'audio', siteKey = null, invisible = false } = options;
    const startTime = Date.now();

    console.log('🤖 开始简化的 reCAPTCHA v2 解决流程...');

    try {
      // 1. 等待页面加载
      console.log('⏳ 等待页面完全加载...');
      await this._sleep(3000);
      await this._removeBlockingAds(page);

      // 2. 查找并点击 reCAPTCHA 复选框
      if (method === 'invisible' || invisible) {
        console.log('Starting reCAPTCHA v2 invisible mode...');
        const token = await this._solveInvisible(page, { siteKey, timeout, language, startTime, submitSelector: options.submitSelector });
        return { success: true, token, challengeType: 'invisible', solveTime: Date.now() - startTime };
      }
      const checkboxClicked = await this._clickCheckbox(page);
      if (!checkboxClicked) {
        throw new RecaptchaNotFoundError('无法找到或点击 reCAPTCHA 复选框');
      }

      // 3. 等待并检查是否自动通过
      await this._sleep(3000);
      const isAlreadySolved = await this._isCheckboxSolved(page);
      
      if (isAlreadySolved) {
        console.log('✅ reCAPTCHA 自动通过验证');
        const token = await this._getToken(page);
        if (token) {
          return {
            success: true,
            token: token,
            challengeType: 'none',
            solveTime: Date.now() - startTime
          };
        }
      }

      // 4. 处理音频挑战
      console.log('🎵 开始音频挑战处理...');
      const solved = await this._solveAudioChallenge(page, language);

      if (!solved) {
        throw new RecaptchaSolveError('音频挑战解决失败');
      }

      // 5. 获取最终 token
      const token = await this._getToken(page);
      if (!token) {
        throw new RecaptchaSolveError('验证通过但未获得 token');
      }

      const solveTime = Date.now() - startTime;
      console.log(`✅ reCAPTCHA v2 解决成功 (${solveTime}ms)`);

      return {
        success: true,
        token: token,
        challengeType: 'audio',
        solveTime: solveTime
      };

    } catch (error) {
      const solveTime = Date.now() - startTime;
      console.error(`❌ reCAPTCHA v2 解决失败 (${solveTime}ms):`, error.message);
      throw new RecaptchaSolveError(`Simple reCAPTCHA v2 solving failed: ${error.message}`);
    }
  }

  /**
   * 查找并点击 reCAPTCHA 复选框
   */
  async _removeBlockingAds(page) {
    try {
      const removed = await page.evaluate(() => {
        const selectors = [
          '.fc-message-root',
          '[class*="fc-message-root"]',
          '[id*="google_vignette"]',
          '[class*="google_vignette"]'
        ];
        let count = 0;
        for (const selector of selectors) {
          for (const el of document.querySelectorAll(selector)) {
            el.remove();
            count++;
          }
        }
        document.documentElement.style.overflow = 'auto';
        if (document.body) {
          document.body.style.overflow = 'auto';
          document.body.style.pointerEvents = 'auto';
        }
        return count;
      });
      if (removed > 0) {
        console.log('🧹 已删除广告弹窗/遮罩: ' + removed + ' 个');
        await this._sleep(500);
      }
    } catch (error) {
      console.log('⚠️ 清理广告弹窗失败: ' + error.message);
    }
  }

  async _waitForToken(page, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const token = await this._getToken(page, { quiet: true });
      if (token) return token;
      await this._sleep(500);
    }
    return null;
  }

  async _findRecaptchaWidgetIds(page) {
    try {
      return await page.evaluate(() => {
        const ids = new Set();
        const cfg = window.___grecaptcha_cfg;
        const seen = new Set();
        function scan(value) {
          if (!value || typeof value !== 'object' || seen.has(value)) return;
          seen.add(value);
          if (value.id !== undefined && (value.sitekey || value.siteKey || value.size || value.callback)) ids.add(String(value.id));
          for (const [key, child] of Object.entries(value)) {
            if (/^\d+$/.test(key) && child && typeof child === 'object') ids.add(String(key));
            scan(child);
          }
        }
        if (cfg && cfg.clients) scan(cfg.clients);
        for (const el of document.querySelectorAll('.g-recaptcha, [data-sitekey]')) {
          const id = el.getAttribute('data-widget-id') || el.getAttribute('data-widgetid');
          if (id !== null && id !== '') ids.add(String(id));
        }
        return [...ids].filter((id) => /^\d+$/.test(id));
      });
    } catch (e) { return []; }
  }

  async _ensureInvisibleWidget(page, siteKey) {
    if (!siteKey) return false;
    try {
      return await page.evaluate(async ({ siteKey }) => {
        if (!window.grecaptcha || typeof window.grecaptcha.render !== 'function') return false;
        let container = document.querySelector('#codex-recaptcha-v2-invisible');
        if (!container) {
          container = document.createElement('div');
          container.id = 'codex-recaptcha-v2-invisible';
          container.style.cssText = 'position:absolute;left:0;top:0;width:1px;height:1px;z-index:2147483647;';
          document.body.appendChild(container);
        }
        if (!container.getAttribute('data-widget-id')) {
          const id = window.grecaptcha.render(container, { sitekey: siteKey, size: 'invisible' });
          container.setAttribute('data-widget-id', String(id));
        }
        return true;
      }, { siteKey });
    } catch (e) { return false; }
  }

  async _installInvisibleTokenCapture(page) {
    try {
      await page.evaluate(() => {
        window.__codexRecaptchaTokens = window.__codexRecaptchaTokens || [];
        const install = () => {
          if (!window.grecaptcha || typeof window.grecaptcha.execute !== 'function' || window.grecaptcha.__codexExecuteWrapped) return;
          const originalExecute = window.grecaptcha.execute.bind(window.grecaptcha);
          window.grecaptcha.execute = function(...args) {
            const result = originalExecute(...args);
            if (result && typeof result.then === 'function') {
              result.then((token) => {
                if (token && String(token).length > 50) window.__codexRecaptchaTokens.push(String(token));
              }).catch(() => {});
            } else if (result && String(result).length > 50) {
              window.__codexRecaptchaTokens.push(String(result));
            }
            return result;
          };
          window.grecaptcha.__codexExecuteWrapped = true;
        };
        install();
        let tries = 0;
        const timer = setInterval(() => {
          install();
          if (++tries > 60 || (window.grecaptcha && window.grecaptcha.__codexExecuteWrapped)) clearInterval(timer);
        }, 250);
      });
    } catch (e) {}
  }

  async _waitForTokenOrChallenge(page, timeout = 15000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const token = await this._getToken(page, { quiet: true });
      if (token) return { type: 'token', token };
      const frame = await this._findChallengeFrameQuick(page);
      if (frame) return { type: 'challenge' };
      await this._sleep(500);
    }
    return { type: 'timeout' };
  }

  async _findChallengeFrameQuick(page) {
    for (const frame of page.frames()) {
      const url = frame.url();
      if (this._isRecaptchaFrame(url) && !this._isAdFrame(url) && (url.includes('bframe') || url.includes('challenge'))) return frame;
    }
    return null;
  }
  async _clickInvisibleSubmitTrigger(page, submitSelector = null) {
    await this._removeBlockingAds(page);
    const selectors = [];
    if (submitSelector) selectors.push(submitSelector);
    selectors.push(
      'button.g-recaptcha',
      'input.g-recaptcha',
      '.g-recaptcha[data-size="invisible"]',
      'button[type="submit"]',
      'input[type="submit"]',
      'button[type="button"]',
      'input[type="button"]',
      '[type="submit"]',
      '[onclick*="grecaptcha"]',
      '[onclick*="recaptcha"]',
      '[onclick*="renew" i]',
      '.btn',
      'button'
    );

    for (const selector of selectors) {
      try {
        const clicked = await page.evaluate((selector) => {
          const el = document.querySelector(selector);
          if (!el) return false;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none' || el.disabled) return false;
          el.scrollIntoView({ block: 'center', inline: 'center' });
          el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
          el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true, view: window }));
          el.click();
          return true;
        }, selector);
        if (clicked) {
          console.log('Invisible trigger clicked selector: ' + selector);
          await this._sleep(3000);
          return true;
        }
      } catch (e) {}
    }

    try {
      const clickedByText = await page.evaluate(() => {
        const candidates = [...document.querySelectorAll('button, input[type="button"], input[type="submit"], .btn, [onclick], a, [role="button"]')];
        const match = candidates.find((el) => {
          const text = [el.innerText, el.textContent, el.value, el.id, el.className, el.getAttribute('aria-label'), el.getAttribute('title')]
            .filter(Boolean).join(' ').toLowerCase();
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none' || el.disabled) return false;
          return text.includes('renew') || text.includes('submit') || text.includes('send') || text.includes('continue') || text.includes('verify');
        });
        if (!match) return false;
        match.scrollIntoView({ block: 'center', inline: 'center' });
        match.click();
        return true;
      });
      if (clickedByText) {
        console.log('Invisible trigger clicked by text fallback');
        await this._sleep(3000);
        return true;
      }
    } catch (e) {}

    try {
      const submitted = await page.evaluate(() => {
        const forms = [...document.querySelectorAll('form')];
        const form = forms.find((f) => f.querySelector('.g-recaptcha, [data-sitekey], iframe[src*="recaptcha"]')) || forms[0];
        if (!form) return false;
        if (typeof form.requestSubmit === 'function') form.requestSubmit();
        else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
        return true;
      });
      if (submitted) {
        console.log('Invisible trigger submitted form fallback');
        await this._sleep(3000);
        return true;
      }
    } catch (e) {}

    return false;
  }
  async _executeInvisible(page, siteKey) {
    await this._removeBlockingAds(page);
    await page.waitForSelector('iframe[src*="google.com/recaptcha"], iframe[src*="recaptcha.net/recaptcha"], .g-recaptcha, [data-sitekey]', { timeout: 30000 }).catch(() => null);
    await this._ensureInvisibleWidget(page, siteKey);
    const widgetIds = await this._findRecaptchaWidgetIds(page);
    console.log('Invisible widget ids: ' + (widgetIds.length ? widgetIds.join(',') : 'none'));
    return await page.evaluate(async ({ widgetIds, siteKey }) => {
      if (!window.grecaptcha || typeof window.grecaptcha.execute !== 'function') return { executed: false, error: 'grecaptcha.execute not available' };
      const calls = [];
      for (const id of widgetIds) calls.push(Number(id));
      calls.push(undefined);
      let lastError = null;
      for (const id of calls) {
        try {
          let result = id === undefined ? window.grecaptcha.execute() : window.grecaptcha.execute(id);
          if (result && typeof result.then === 'function') {
            const token = await Promise.race([result, new Promise((resolve) => setTimeout(() => resolve(null), 10000))]);
            if (token) return { executed: true, token, widgetId: id };
          }
          return { executed: true, widgetId: id };
        } catch (e) { lastError = e && e.message ? e.message : String(e); }
      }
      if (siteKey) {
        try {
          const result = window.grecaptcha.execute(siteKey, {});
          if (result && typeof result.then === 'function') {
            const token = await Promise.race([result, new Promise((resolve) => setTimeout(() => resolve(null), 10000))]);
            if (token) return { executed: true, token, siteKey: true };
          }
          return { executed: true, siteKey: true };
        } catch (e) { lastError = e && e.message ? e.message : String(e); }
      }
      return { executed: false, error: lastError || 'execute failed' };
    }, { widgetIds, siteKey });
  }

  async _solveInvisible(page, { siteKey, timeout = 120000, language = 'en-US', submitSelector = null } = {}) {
    await this._installInvisibleTokenCapture(page);
    const clickedSubmit = await this._clickInvisibleSubmitTrigger(page, submitSelector);
    if (clickedSubmit) {
      const clickedResult = await this._waitForTokenOrChallenge(page, 15000);
      if (clickedResult.type === 'token') {
        console.log('Invisible submit click produced token');
        return clickedResult.token;
      }
      if (clickedResult.type === 'challenge') {
        console.log('Invisible submit click opened challenge, using audio flow...');
        const solved = await this._solveAudioChallenge(page, language);
        if (!solved) throw new RecaptchaSolveError('invisible submit audio challenge failed');
        const token = await this._waitForToken(page, 15000) || await this._getToken(page);
        if (token) return token;
      }
    }

    const executeResult = await this._executeInvisible(page, siteKey);
    if (executeResult && executeResult.token && executeResult.token.length > 50) {
      console.log('Invisible execute returned token directly');
      return executeResult.token;
    }
    if (!executeResult || !executeResult.executed) console.log('Invisible execute did not complete directly: ' + (executeResult && executeResult.error ? executeResult.error : 'unknown'));
    let token = await this._waitForToken(page, 15000);
    if (token) { console.log('Invisible mode detected page token'); return token; }
    const challengeFrame = await this._findChallengeFrame(page);
    if (challengeFrame) {
      console.log('Invisible mode opened challenge, using audio flow...');
      const solved = await this._solveAudioChallenge(page, language);
      if (!solved) throw new RecaptchaSolveError('invisible audio challenge failed');
      token = await this._waitForToken(page, 15000) || await this._getToken(page);
      if (token) return token;
    }
    throw new RecaptchaSolveError('invisible reCAPTCHA flow finished but no token was extracted');
  }
  async _clickCheckbox(page) {
    await this._removeBlockingAds(page);
    console.log('🔍 查找 reCAPTCHA 复选框...');

    // 等待 reCAPTCHA iframe 加载
    try {
      await page.waitForSelector('iframe[src*="google.com/recaptcha"], iframe[src*="recaptcha.net/recaptcha"]', { timeout: 15000 });
    } catch (error) {
      console.log('❌ 未找到 reCAPTCHA iframe');
      return false;
    }

    // 获取所有 iframe
    const frames = page.frames();
    console.log(`📋 检测到 ${frames.length} 个框架`);

    // 查找包含复选框的 iframe (anchor frame)
    for (const frame of frames) {
      const url = frame.url();
      console.log(`🔍 检查框架: ${url}`);
      
      if (this._isRecaptchaFrame(url) && !this._isAdFrame(url) && url.includes('anchor')) {
        console.log('✅ 找到 reCAPTCHA anchor 框架');
        
        try {
          // 等待复选框出现
          await frame.waitForSelector('#recaptcha-anchor', { timeout: 10000 });
          
          // 点击复选框
          await frame.click('#recaptcha-anchor');
          console.log('✅ 成功点击复选框');
          
          return true;
        } catch (error) {
          console.log(`❌ 点击复选框失败: ${error.message}`);
          
          // 尝试其他可能的选择器
          const selectors = [
            '.recaptcha-checkbox-border',
            '.recaptcha-checkbox',
            '[role="checkbox"]'
          ];
          
          for (const selector of selectors) {
            try {
              await frame.waitForSelector(selector, { timeout: 5000 });
              await frame.click(selector);
              console.log(`✅ 使用选择器 ${selector} 成功点击`);
              return true;
            } catch (e) {
              continue;
            }
          }
        }
      }
    }

    console.log('❌ 未找到可点击的复选框');
    return false;
  }

  /**
   * 检查复选框是否已被勾选（自动通过）
   */
  async _isCheckboxSolved(page) {
    const frames = page.frames();

    for (const frame of frames) {
      const frameUrl = frame.url();
      if (this._isRecaptchaFrame(frameUrl) && !this._isAdFrame(frameUrl) && frameUrl.includes('anchor')) {
        try {
          const state = await frame.evaluate(() => {
            const anchor = document.querySelector('#recaptcha-anchor');
            if (!anchor) return { found: false };
            return {
              found: true,
              ariaChecked: anchor.getAttribute('aria-checked'),
              className: String(anchor.className || ''),
              checked: anchor.classList.contains('recaptcha-checkbox-checked')
            };
          });

          if (state && (state.ariaChecked === 'true' || state.checked || state.className.includes('recaptcha-checkbox-checked'))) {
            console.log('✅ reCAPTCHA anchor 已勾选');
            return true;
          }
        } catch (error) {
          continue;
        }
      }
    }

    return false;
  }

  async _waitForChallengeSolved(page, timeout = 12000) {
    const deadline = Date.now() + timeout;
    let lastState = null;

    while (Date.now() < deadline) {
      const token = await this._getToken(page, { quiet: true });
      if (token) {
        console.log(`✅ 检测到 reCAPTCHA token (长度: ${token.length})`);
        return true;
      }

      if (await this._isCheckboxSolved(page)) {
        return true;
      }

      for (const frame of page.frames()) {
        const url = frame.url();
        if (this._isRecaptchaFrame(url) && !this._isAdFrame(url) && (url.includes('bframe') || url.includes('challenge'))) {
          try {
            const state = await frame.evaluate(() => {
              const bodyText = (document.body && document.body.innerText || '').toLowerCase();
              const errorText = [
                '.rc-audiochallenge-error-message',
                '.rc-audiochallenge-incorrect-response',
                '.rc-audiochallenge-error-message-auto',
                '#rc-audiochallenge-error-message'
              ].map((selector) => {
                const el = document.querySelector(selector);
                return el && el.offsetParent !== null ? (el.textContent || '').trim() : '';
              }).filter(Boolean).join(' ').toLowerCase();

              const verifyButton = document.querySelector('#recaptcha-verify-button');
              const audioInput = document.querySelector('#audio-response');
              const challengeGone = !audioInput && !verifyButton;
              const successText = bodyText.includes('verification complete') ||
                bodyText.includes('you are verified') ||
                bodyText.includes('验证成功') ||
                bodyText.includes('验证完成') ||
                bodyText.includes('已通过');

              return { challengeGone, successText, errorText, bodyText: bodyText.slice(0, 200) };
            });

            lastState = state;
            if (state && (state.successText || (state.challengeGone && !state.errorText))) {
              console.log('✅ reCAPTCHA 音频框架显示已完成');
              return true;
            }
            if (state && state.errorText) {
              console.log(`⚠️ reCAPTCHA 音频框架仍有错误提示: ${state.errorText}`);
              return false;
            }
          } catch (_) {}
        }
      }

      await this._sleep(500);
    }

    if (lastState) {
      console.log(`⚠️ reCAPTCHA 成功检测超时，最后状态: ${JSON.stringify(lastState)}`);
    }
    return false;
  }

  /**
   * 解决音频挑战
   */
  async _solveAudioChallenge(page, language) {
    console.log('🎵 开始音频挑战处理...');

    let attempts = 0;
    while (attempts < this.maxAttempts) {
      attempts++;
      console.log(`🎯 音频挑战尝试 ${attempts}/${this.maxAttempts}`);

      try {
        // 每轮都重新查找 bframe。reCAPTCHA 在 reload/失败后会销毁旧 iframe，
        // 继续复用旧 Frame 会触发 “Attempted to use detached Frame”。
        let challengeFrame = await this._findChallengeFrame(page);
        if (!challengeFrame) {
          throw new RecaptchaSolveError('未找到挑战框架');
        }

        // 1. 切换到音频挑战
        await this._switchToAudioChallenge(challengeFrame);

        // 切换模式后 frame 也可能刷新，重新取一次当前有效 frame。
        challengeFrame = await this._findChallengeFrame(page) || challengeFrame;

        // 2. 获取音频 URL
        const audioUrl = await this._getAudioUrl(challengeFrame);
        if (!audioUrl) {
          throw new Error('无法获取音频 URL');
        }

        // 3. 下载并处理音频
        const transcription = await this._processAudio(page, audioUrl, language);
        if (!transcription) {
          throw new Error('音频转录失败');
        }

        // 4. 提交答案
        await this._submitAudioResponse(challengeFrame, transcription);

        // 5. 轮询验证结果。音频框架可能先显示成功，anchor/token 会晚几秒更新。
        const isSuccess = await this._waitForChallengeSolved(page, 12000);
        if (isSuccess) {
          console.log('✅ 音频挑战解决成功');
          return true;
        }

        console.log(`❌ 尝试 ${attempts} 失败，准备重试...`);
        if (attempts < this.maxAttempts) {
          const freshFrame = await this._findChallengeFrame(page);
          if (freshFrame) {
            await this._reloadChallenge(freshFrame);
          }
          await this._sleep(2000);
        }

      } catch (error) {
        console.log(`❌ 音频挑战尝试 ${attempts} 出错: ${error.message}`);
        if (attempts >= this.maxAttempts) {
          throw error;
        }
        await this._sleep(1500);
      }
    }

    return false;
  }

  /**
   * 查找挑战框架
   */
  async _findChallengeFrame(page) {
    const deadline = Date.now() + 20000;

    while (Date.now() < deadline) {
      const frames = page.frames();
      for (const frame of frames) {
        const url = frame.url();
        if (this._isRecaptchaFrame(url) && !this._isAdFrame(url) && (url.includes('bframe') || url.includes('challenge'))) {
          console.log(`✅ 找到挑战框架: ${url}`);
          return frame;
        }
      }
      await this._removeBlockingAds(page);
      await this._sleep(500);
    }
    
    console.log('❌ 未找到挑战框架');
    return null;
  }

  /**
   * 切换到音频挑战
   */
  async _switchToAudioChallenge(frame) {
    console.log('🔄 切换到音频挑战...');
    
    const selectors = [
      '#recaptcha-audio-button',
      '.rc-button-audio',
      '[aria-label*="audio" i]',
      'button[title*="audio" i]',
      'button[id*="audio" i]'
    ];

    for (const selector of selectors) {
      try {
        await frame.waitForSelector(selector, { timeout: 8000 });
        await frame.click(selector);
        console.log(`✅ 使用选择器 ${selector} 切换到音频`);
        await this._sleep(2000);
        return;
      } catch (error) {
        continue;
      }
    }

    // Puppeteer/CSS 选择器在跨语言页面上偶尔匹配不到，用 DOM 特征兜底点击。
    const clicked = await frame.evaluate(() => {
      const candidates = [...document.querySelectorAll('button, [role="button"], div')];
      const el = candidates.find((node) => {
        const text = [
          node.id,
          node.className,
          node.getAttribute?.('aria-label'),
          node.getAttribute?.('title'),
          node.textContent
        ].filter(Boolean).join(' ').toLowerCase();
        return text.includes('audio') || text.includes('headphones') || text.includes('声音') || text.includes('音频');
      });
      if (el) {
        el.click();
        return true;
      }
      return false;
    }).catch(() => false);

    if (clicked) {
      console.log('✅ 使用 DOM 兜底逻辑切换到音频');
      await this._sleep(2000);
      return;
    }

    throw new Error('无法切换到音频挑战');
  }

  /**
   * 获取音频 URL
   */
  async _getAudioUrl(frame) {
    console.log('🔍 获取音频 URL...');
    
    const audioSelectors = [
      '#audio-source',
      '.rc-audiochallenge-tdownload-link',
      'a[href*=".mp3"]',
      'audio source'
    ];

    for (const selector of audioSelectors) {
      try {
        await frame.waitForSelector(selector, { timeout: 5000 });
        const href = await frame.$eval(selector, el => el.getAttribute('href') || el.getAttribute('src'));
        if (href && href.includes('.mp3')) {
          console.log(`✅ 找到音频 URL: ${href}`);
          return href;
        }
      } catch (error) {
        continue;
      }
    }

    throw new Error('未找到音频 URL');
  }

  /**
   * 处理音频：下载、转换、识别
   */
  async _processAudio(page, audioUrl, language) {
    try {
      console.log('🎵 开始音频处理...');

      // 初始化音频处理器
      if (!this.audioProcessor.initialized) {
        await this.audioProcessor.initialize();
      }

      // 下载音频
      const audioBuffer = await this.audioProcessor.downloadAudio(page, audioUrl);
      
      // 转换格式
      const wavBuffer = await this.audioProcessor.convertToWav(audioBuffer, 'mp3');
      
      // 语音识别
      const transcription = await this.audioProcessor.transcribeAudio(wavBuffer, language);
      
      console.log(`✅ 音频处理完成: "${transcription}"`);
      return transcription;

    } catch (error) {
      console.error('音频处理失败:', error);
      throw error;
    }
  }

  /**
   * 提交音频响应
   */
  async _submitAudioResponse(frame, text) {
    console.log(`📝 提交音频响应: "${text}"`);
    
    // 查找输入框
    const inputSelectors = [
      '#audio-response',
      '.rc-audiochallenge-response-field',
      'input[name="response"]'
    ];

    for (const selector of inputSelectors) {
      try {
        await frame.waitForSelector(selector, { timeout: 5000 });
        await frame.evaluate((selector, text) => {
          const input = document.querySelector(selector);
          if (!input) throw new Error('input not found');
          input.value = text;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }, selector, text);
        console.log(`✅ 使用选择器 ${selector} 填入文本`);
        break;
      } catch (error) {
        continue;
      }
    }

    // 查找提交按钮
    const submitSelectors = [
      '#recaptcha-verify-button',
      '.rc-audiochallenge-verify-button',
      'button[type="submit"]'
    ];

    for (const selector of submitSelectors) {
      try {
        await frame.waitForSelector(selector, { timeout: 5000 });
        await frame.click(selector);
        console.log(`✅ 使用选择器 ${selector} 提交`);
        return;
      } catch (error) {
        continue;
      }
    }

    throw new Error('无法提交音频响应');
  }

  /**
   * 检查挑战是否解决
   */
  async _isChallengeSolved(page) {
    return await this._isCheckboxSolved(page);
  }

  /**
   * 重新加载挑战
   */
  async _reloadChallenge(frame) {
    console.log('🔄 重新加载挑战...');
    
    const reloadSelectors = [
      '#recaptcha-reload-button',
      '.rc-button-reload',
      'button[title*="reload"]'
    ];

    for (const selector of reloadSelectors) {
      try {
        await frame.waitForSelector(selector, { timeout: 3000 });
        await frame.click(selector);
        console.log(`✅ 使用选择器 ${selector} 重新加载`);
        return;
      } catch (error) {
        continue;
      }
    }
  }

  /**
   * 获取 reCAPTCHA token
   */
  async _getToken(page, options = {}) {
    const methods = [
      () => page.evaluate(() => {
        const list = window.__codexRecaptchaTokens || [];
        return list.length ? list[list.length - 1] : null;
      }),
      // 方法1: 查找隐藏的 textarea
      () => page.evaluate(() => {
        const textarea = document.querySelector('textarea[name="g-recaptcha-response"]');
        return textarea ? textarea.value : null;
      }),
      
      // 方法2: 使用 grecaptcha API
      () => page.evaluate(() => {
        return window.grecaptcha && window.grecaptcha.getResponse ? 
          window.grecaptcha.getResponse() : null;
      }),
      
      // 方法3: 查找 ID
      () => page.evaluate(() => {
        const response = document.getElementById('g-recaptcha-response');
        return response ? response.value : null;
      })
    ];

    for (const method of methods) {
      try {
        const token = await method();
        if (token && token.length > 50) {
          console.log(`✅ 获取到 token (长度: ${token.length})`);
          return token;
        }
      } catch (e) {
        continue;
      }
    }

    if (!options.quiet) console.log('❌ 未获取到有效 token');
    return null;
  }
}

module.exports = SimpleRecaptchaV2Solver;
