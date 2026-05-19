const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// 加载根目录的统一配置文件
require('dotenv').config({ path: path.join(__dirname, '../../.env') })

/**
 * 解决 hCaptcha 验证码
 * @param {Object} req - Express 请求对象
 * @param {Object} res - Express 响应对象
 */
async function solveHcaptcha(req, res) {
    const requestId = Date.now() + '_' + Math.random().toString(36).substring(2, 11);
    const startTime = new Date();
    
    console.log(`🎯 [${requestId}] hCaptcha请求开始: ${new Date().toISOString()}`);
    console.log(`📍 [${requestId}] 请求参数:`, req.body);
    
    try {
        const { type, websiteUrl, websiteKey, proxy } = req.body;

        // 验证必填参数
        if (!type || type !== 'hcaptcha') {
            return res.status(400).json({
                code: 400,
                message: 'Invalid or missing type parameter. Must be "hcaptcha"',
                token: null
            });
        }

        if (!websiteUrl || !websiteKey) {
            return res.status(400).json({
                code: 400,
                message: 'Missing required parameters: websiteUrl and websiteKey',
                token: null
            });
        }

        console.log(`📊 [${requestId}] 更新监控计数器`);
        
        // 增加活跃请求计数
        global.activeRequestCount++;
        global.monitoringData.totalRequests++;
        
        // 记录活跃请求
        global.monitoringData.activeRequests.set(requestId, {
            id: requestId,
            url: websiteUrl,
            mode: 'hcaptcha',
            startTime: startTime,
            clientIP: req.ip || req.socket.remoteAddress
        });
        
        // 更新按服务分组的活跃请求计数
        global.monitoringData.activeRequestsByService.hcaptcha++;
        
        console.log(`📈 [${requestId}] 当前活跃请求: ${global.activeRequestCount}, hCaptcha活跃: ${global.monitoringData.activeRequestsByService.hcaptcha}`);

        // 准备参数
        const params = {
            websiteUrl,
            websiteKey
        };

        if (proxy) {
            params.proxy = proxy;
        }

        console.log(`🐍 [${requestId}] 准备调用Python解决器，参数:`, params);
        
        let result;
        try {
            // 调用 Python 解决器
            console.log(`⏰ [${requestId}] 开始调用Python解决器: ${new Date().toISOString()}`);
            result = await callHcaptchaSolver(params);
            console.log(`✅ [${requestId}] Python解决器返回结果: ${new Date().toISOString()}`, result);
            
            // 请求成功
            if (result.code === 200) {
                global.monitoringData.successfulRequests++;
                
                // 记录token（如果有）
                if (result.token) {
                    global.monitoringData.recentTokens.unshift({
                        token: result.token,
                        url: websiteUrl,
                        mode: 'hcaptcha',
                        timestamp: new Date(),
                        requestId: requestId
                    });
                    
                    // 只保留最近50个token
                    if (global.monitoringData.recentTokens.length > 50) {
                        global.monitoringData.recentTokens = global.monitoringData.recentTokens.slice(0, 50);
                    }
                }
            } else {
                global.monitoringData.failedRequests++;
            }
        } catch (error) {
            console.error(`💥 [${requestId}] Python解决器调用出错:`, error.message);
            console.error(`🔍 [${requestId}] 错误堆栈:`, error.stack);
            global.monitoringData.failedRequests++;
            result = {
                code: 500,
                message: `Internal server error: ${error.message}`,
                token: null
            };
        } finally {
            console.log(`🧹 [${requestId}] 清理资源，总耗时: ${Date.now() - startTime.getTime()}ms`);
            // 减少活跃请求计数
            global.activeRequestCount--;
            global.monitoringData.activeRequestsByService.hcaptcha--;
            global.monitoringData.activeRequests.delete(requestId);
            
            // 记录请求历史
            global.monitoringData.requestHistory.unshift({
                requestId: requestId,
                url: websiteUrl,
                mode: 'hcaptcha',
                success: result.code === 200,
                timestamp: new Date(),
                responseTime: Date.now() - startTime.getTime()
            });
            
            // 只保留最近100条历史
            if (global.monitoringData.requestHistory.length > 100) {
                global.monitoringData.requestHistory = global.monitoringData.requestHistory.slice(0, 100);
            }
        }
        
        // 返回结果
        res.status(result.code || 500).json(result);

    } catch (error) {
        console.error('Error in solveHcaptcha:', error);
        // 确保在异常情况下也减少计数
        global.activeRequestCount--;
        global.monitoringData.activeRequestsByService.hcaptcha--;
        global.monitoringData.activeRequests.delete(requestId);
        res.status(500).json({
            code: 500,
            message: `Internal server error: ${error.message}`,
            token: null
        });
    }
}

/**
 * 调用 hCaptcha 解决器
 * @param {Object} params - 参数对象
 * @returns {Promise<Object>} 解决结果
 */
function callHcaptchaSolver(params) {
    return new Promise((resolve) => {
        const solverDir = path.join(__dirname);
        const solverPath = path.join(solverDir, 'solver.py');
        const venvPythonPath = path.join(solverDir, 'venv', 
            process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
        
        // 使用虚拟环境的 Python，如果不存在则使用系统 Python
        const pythonCommand = fs.existsSync(venvPythonPath) ? venvPythonPath : 'python3';
        const paramsJson = JSON.stringify(params);
        
        console.log(`🔧 Python命令: ${pythonCommand}`);
        console.log(`📁 解决器路径: ${solverPath}`);
        console.log(`📄 参数JSON: ${paramsJson}`);

        // 启动 Python 子进程，重定向stderr到平台对应的空设备
        console.log(`🚀 启动Python进程: ${new Date().toISOString()}`);
        const devNull = fs.openSync(process.platform === 'win32' ? 'NUL' : '/dev/null', 'w');
        
        const pythonProcess = spawn(pythonCommand, [solverPath, paramsJson], {
            stdio: ['pipe', 'pipe', devNull], // 重定向stderr到/dev/null
            cwd: solverDir,
            env: { 
                ...process.env, 
                LOG_LEVEL: 'CRITICAL',
                PYTHONIOENCODING: 'utf-8',
                PYTHONUNBUFFERED: '1'  // 确保Python输出不被缓冲
            }
        });

        let stdout = '';

        // 收集标准输出
        pythonProcess.stdout.on('data', (data) => {
            const chunk = data.toString();
            stdout += chunk;
        });

        // 处理进程退出
        pythonProcess.on('close', (code) => {
            console.log(`🔚 Python进程退出，代码: ${code}, 时间: ${new Date().toISOString()}`);
            console.log(`📊 stdout长度: ${stdout.length}`);
            
            if (code !== 0) {
                console.error('❌ hCaptcha solver failed with exit code:', code);
                return resolve({
                    code: 500,
                    message: `hCaptcha solver failed with exit code ${code}`,
                    token: null
                });
            }

            try {
                console.log(`🔍 原始输出长度: ${stdout.length}`);
                
                // 优先使用特殊标记方法查找JSON
                const resultMatch = stdout.match(/RESULT_JSON_START:(.+?):RESULT_JSON_END/);
                let jsonResult = null;
                
                if (resultMatch) {
                    try {
                        jsonResult = JSON.parse(resultMatch[1]);
                        console.log(`✅ 通过特殊标记找到JSON: ${resultMatch[1]}`);
                    } catch (e) {
                        console.log(`⚠️ 特殊标记的内容不是有效JSON: ${e.message}`);
                    }
                }
                
                // 如果特殊标记方法失败，fallback到清理输出的方法
                if (!jsonResult) {
                    console.log(`🔄 特殊标记方法失败，尝试清理输出`);
                    
                    // 清理输出中的ANSI转义序列和控制字符
                    let cleanOutput = stdout
                        .replace(/\x1b\[[0-9;]*m/g, '')  // 移除ANSI颜色代码
                        .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')  // 移除其他ANSI序列
                        .replace(/[\x00-\x1f\x7f-\x9f]/g, '\n')  // 将控制字符替换为换行符
                        .trim();
                    
                    console.log(`🔍 清理后的输出长度: ${cleanOutput.length}`);
                    
                    // 查找最后一个完整的JSON对象
                    const lines = cleanOutput.split('\n');
                    for (let i = lines.length - 1; i >= 0; i--) {
                        const line = lines[i].trim();
                        if (line.startsWith('{') && line.endsWith('}')) {
                            try {
                                jsonResult = JSON.parse(line);
                                console.log(`✅ 找到JSON在第${i+1}行: ${line}`);
                                break;
                            } catch (e) {
                                console.log(`⚠️ 第${i+1}行不是有效JSON: ${line.substring(0, 50)}... 错误: ${e.message}`);
                            }
                        }
                    }
                    
                    // 如果还是没找到，再次尝试特殊标记
                    if (!jsonResult) {
                        const cleanResultMatch = cleanOutput.match(/RESULT_JSON_START:(.+?):RESULT_JSON_END/);
                        if (cleanResultMatch) {
                            try {
                                jsonResult = JSON.parse(cleanResultMatch[1]);
                                console.log(`✅ 清理后通过特殊标记找到JSON: ${cleanResultMatch[1]}`);
                            } catch (e) {
                                console.log(`⚠️ 清理后特殊标记的内容不是有效JSON: ${e.message}`);
                            }
                        }
                    }
                    
                    // 最后尝试正则表达式匹配简单的JSON结构
                    if (!jsonResult) {
                        const simpleJsonMatch = cleanOutput.match(/\{\s*"code"\s*:\s*\d+\s*,\s*"message"\s*:\s*"[^"]*"\s*,\s*"token"\s*:\s*(?:"[^"]*"|null)\s*\}/);
                        if (simpleJsonMatch) {
                            try {
                                jsonResult = JSON.parse(simpleJsonMatch[0]);
                                console.log(`✅ 通过简单正则表达式找到JSON: ${simpleJsonMatch[0]}`);
                            } catch (e) {
                                console.log(`⚠️ 简单正则匹配的内容不是有效JSON: ${e.message}`);
                            }
                        }
                    }
                }
                
                if (!jsonResult) {
                    console.error('🔍 调试信息 - 原始输出:');
                    console.error(stdout);
                    throw new Error('No valid JSON output found');
                }
                
                console.log(`✅ 成功解析JSON结果:`, jsonResult);
                resolve(jsonResult);
            } catch (parseError) {
                console.error('❌ 解析Python输出失败:', parseError.message);
                console.error('🔍 原始输出长度:', stdout.length);
                const lines = stdout.split('\n');
                console.error('🔍 输出行数:', lines.length);
                console.error('🔍 最后5行:');
                lines.slice(-5).forEach((line, index) => {
                    console.error(`  ${lines.length - 5 + index + 1}: ${line}`);
                });
                resolve({
                    code: 500,
                    message: `Failed to parse solver output: ${parseError.message}`,
                    token: null
                });
            }
        });

        // 处理进程错误
        pythonProcess.on('error', (error) => {
            console.error('💥 启动hCaptcha解决器失败:', error.message);
            console.error('🔍 错误详情:', error);
            resolve({
                code: 500,
                message: `Failed to start solver: ${error.message}`,
                token: null
            });
        });

        // 设置超时 (使用统一配置)
        const hcaptchaTimeout = Number(process.env.HCAPTCHA_SOLVER_TIMEOUT) || 300000;
        const timeout = setTimeout(() => {
            console.log(`⏰ Python进程超时，强制终止: ${new Date().toISOString()}`);
            pythonProcess.kill('SIGTERM');
            resolve({
                code: 500,
                message: `hCaptcha solving timeout (${hcaptchaTimeout / 1000} seconds)`,
                token: null
            });
        }, hcaptchaTimeout);

        pythonProcess.on('close', () => {
            clearTimeout(timeout);
        });
    });
}

module.exports = { solveHcaptcha };
