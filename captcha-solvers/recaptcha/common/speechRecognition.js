/**
 * 语音识别模块
 * 基于 GoogleRecaptchaBypass 的思路实现本地语音识别
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { AudioTranscriptionError } = require('./errors');

class SpeechRecognition {
  constructor() {
    this.tempDir = os.tmpdir();
    this.pythonScriptPath = path.join(__dirname, 'speech_recognizer.py');
  }

  /**
   * 使用 Python speech_recognition 库进行语音识别
   */
  async recognizeAudio(wavBuffer, language = 'en-US') {
    return new Promise((resolve, reject) => {
      const timestamp = Date.now();
      const tempAudioPath = path.join(this.tempDir, `recaptcha_audio_${timestamp}.wav`);

      try {
        // 写入临时 WAV 文件
        fs.writeFileSync(tempAudioPath, wavBuffer);
        console.log(`🎤 开始语音识别，文件: ${tempAudioPath}`);

        // 调用 Python 脚本进行语音识别
        const python = spawn('python3', [this.pythonScriptPath, tempAudioPath, language]);

        let stdout = '';
        let stderr = '';

        python.stdout.on('data', (data) => {
          stdout += data.toString();
        });

        python.stderr.on('data', (data) => {
          stderr += data.toString();
        });

        python.on('close', (code) => {
          // 清理临时文件
          try {
            fs.unlinkSync(tempAudioPath);
          } catch (e) {}

          if (code === 0) {
            const result = stdout.trim();
            if (result && result !== 'ERROR' && result !== 'TIMEOUT') {
              console.log(`✅ 语音识别成功: "${result}"`);
              resolve(result);
            } else {
              reject(new AudioTranscriptionError(`Speech recognition failed: ${stderr || 'Unknown error'}`));
            }
          } else {
            console.error('Python 脚本错误:', stderr);
            reject(new AudioTranscriptionError(`Python script failed with code ${code}: ${stderr}`));
          }
        });

        python.on('error', (error) => {
          // 清理文件
          try {
            fs.unlinkSync(tempAudioPath);
          } catch (e) {}
          reject(new AudioTranscriptionError(`Python script spawn error: ${error.message}`));
        });

      } catch (error) {
        reject(new AudioTranscriptionError(`Speech recognition setup failed: ${error.message}`));
      }
    });
  }

  /**
   * 检查 Python 和 speech_recognition 库是否可用
   */
  async checkDependencies() {
    try {
      // 检查 Python
      const pythonCheck = await this._runCommand('python3', ['--version']);
      if (!pythonCheck.success) {
        return { available: false, error: 'Python3 not found' };
      }

      // 检查 speech_recognition 库
      const srCheck = await this._runCommand('python3', ['-c', 'import speech_recognition; print("OK")']);
      if (!srCheck.success) {
        return { 
          available: false, 
          error: 'speech_recognition library not found. Install with: pip3 install SpeechRecognition' 
        };
      }

      // 创建 Python 脚本
      await this._createPythonScript();

      return { available: true };
    } catch (error) {
      return { available: false, error: error.message };
    }
  }

  /**
   * 运行命令行工具
   */
  _runCommand(command, args) {
    return new Promise((resolve) => {
      const process = spawn(command, args);
      let stdout = '';
      let stderr = '';

      process.stdout.on('data', (data) => {
        stdout += data.toString();
      });

      process.stderr.on('data', (data) => {
        stderr += data.toString();
      });

      process.on('close', (code) => {
        resolve({
          success: code === 0,
          stdout: stdout.trim(),
          stderr: stderr.trim()
        });
      });

      process.on('error', (error) => {
        resolve({
          success: false,
          error: error.message
        });
      });
    });
  }

  /**
   * 创建 Python 语音识别脚本
   */
  async _createPythonScript() {
    const pythonCode = `#!/usr/bin/env python3
"""
reCAPTCHA 音频识别脚本
基于 GoogleRecaptchaBypass 的思路实现
"""

import sys
import speech_recognition as sr
import os
import tempfile

def recognize_audio(audio_path, language='en-US'):
    """
    识别音频文件中的语音内容
    """
    try:
        # 初始化识别器
        recognizer = sr.Recognizer()
        
        # 读取音频文件
        with sr.AudioFile(audio_path) as source:
            # 调整环境噪音
            recognizer.adjust_for_ambient_noise(source)
            # 录制音频数据
            audio_data = recognizer.record(source)
        
        # 使用 Google 语音识别服务
        try:
            text = recognizer.recognize_google(audio_data, language=language)
            return text.strip()
        except sr.UnknownValueError:
            return "ERROR"
        except sr.RequestError as e:
            print(f"Recognition service error: {e}", file=sys.stderr)
            return "ERROR"
            
    except Exception as e:
        print(f"Audio processing error: {e}", file=sys.stderr)
        return "ERROR"

def main():
    if len(sys.argv) < 2:
        print("Usage: speech_recognizer.py <audio_file> [language]", file=sys.stderr)
        sys.exit(1)
    
    audio_path = sys.argv[1]
    language = sys.argv[2] if len(sys.argv) > 2 else 'en-US'
    
    if not os.path.exists(audio_path):
        print(f"Audio file not found: {audio_path}", file=sys.stderr)
        sys.exit(1)
    
    result = recognize_audio(audio_path, language)
    print(result)

if __name__ == "__main__":
    main()
`;

    fs.writeFileSync(this.pythonScriptPath, pythonCode);
    
    // 设置执行权限
    try {
      fs.chmodSync(this.pythonScriptPath, '755');
    } catch (e) {
      // 忽略权限设置错误
    }
  }

  /**
   * 清理临时文件
   */
  cleanup() {
    try {
      const files = fs.readdirSync(this.tempDir);
      const audioFiles = files.filter(file => file.startsWith('recaptcha_audio_'));
      
      for (const file of audioFiles) {
        try {
          fs.unlinkSync(path.join(this.tempDir, file));
        } catch (e) {
          // 忽略清理错误
        }
      }
    } catch (error) {
      console.warn('音频文件清理警告:', error.message);
    }
  }
}

module.exports = SpeechRecognition;
