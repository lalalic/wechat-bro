/**
 * transcribe.js — Voice message transcription via Whisper STT
 *
 * Decodes a base64-encoded audio blob and runs
 *   uvx --from openai-whisper whisper <tmpfile> --output-format txt
 * to produce a text transcription, attached as voiceText.
 *
 * Shared between cli.js and test-inject.js.
 */

'use strict'

const fs = require('fs')
const path = require('path')
const os = require('os')
const { execSync } = require('child_process')

const UVX_CMD = process.env.UVX_CMD || 'uvx'
const WHISPER_TIMEOUT = parseInt(process.env.WHISPER_TIMEOUT || '120000', 10)

/**
 * Transcribe a base64-encoded voice message.
 * Synchronous – blocks until Whisper finishes.
 *
 * @param {object} data – event data object. If it has voiceBase64 the
 *   function decodes it, runs Whisper, and sets data.voiceText.
 * @returns {boolean} true if transcription was attempted
 */
function transcribeVoice(data) {
  if (!data || !data.voiceBase64 || typeof data.voiceBase64 !== 'string') {
    return false
  }

  let audioBuffer
  try {
    audioBuffer = Buffer.from(data.voiceBase64, 'base64')
  } catch (e) {
    return false
  }
  if (audioBuffer.length < 64) return false  // too small to be useful

  const tmpFile = path.join(os.tmpdir(), `wx_voice_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`)
  const ext = guessAudioExt(audioBuffer)
  const wavFile = tmpFile + ext

  try {
    fs.writeFileSync(wavFile, audioBuffer)

    const stdout = execSync(
      `${UVX_CMD} --from openai-whisper whisper "${wavFile}" --output_dir="${os.tmpdir()}" --output_format=txt --language=zh 2>/dev/null`,
      { timeout: WHISPER_TIMEOUT, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    )

    // Whisper writes a .txt file next to the input
    const txtFile = wavFile.replace(/\.\w+$/, '') + '.txt'
    if (fs.existsSync(txtFile)) {
      data.voiceText = fs.readFileSync(txtFile, 'utf-8').trim()
    } else {
      // Fallback: try with the stdout (whisper also prints text)
      if (stdout) data.voiceText = stdout.trim()
    }
  } catch (e) {
    // Transcription failed – leave voiceText undefined, not critical
  } finally {
    try { if (fs.existsSync(wavFile)) fs.unlinkSync(wavFile) } catch {}
    try {
      const txtFile = wavFile.replace(/\.\w+$/, '') + '.txt'
      if (fs.existsSync(txtFile)) fs.unlinkSync(txtFile)
    } catch {}
  }

  return true
}

/**
 * Guess audio extension from magic bytes.
 * WeChat voice downloads are typically Speex (.spx) or SILK (.sil).
 */
function guessAudioExt(buf) {
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46) return '.wav'
  if (buf[0] === 0x23 && buf[1] === 0x21 && buf[2] === 0x53 && buf[3] === 0x49) return '.sil'   // SILK header: #!SILK…
  if (buf[0] === 0x30 && buf[1] === 0x26 && buf[2] === 0xB2 && buf[3] === 0x75) return '.silk' // SILK
  if (buf[0] === 0x02 && buf[1] === 0x00 && buf[2] === 0x00 && buf[3] === 0x00) return '.spx'  // Speex
  return '.wav'  // fallback – Whisper can try
}

/**
 * Transcribe a local audio file and return the text.
 * @param {string} filePath – absolute path to audio file
 * @returns {string|null} transcribed text, or null on failure
 */
function transcribeFile(filePath) {
  try {
    const stdout = execSync(
      `${UVX_CMD} --from openai-whisper whisper "${filePath}" --output_dir="${os.tmpdir()}" --output_format=txt --language=zh 2>/dev/null`,
      { timeout: WHISPER_TIMEOUT, encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 }
    )

    // Whisper writes a .txt file next to the input (in tmpdir, but uses base filename)
    const base = path.basename(filePath).replace(/\.[^.]+$/, '')
    const txtFile = path.join(os.tmpdir(), base + '.txt')
    if (fs.existsSync(txtFile)) {
      const text = fs.readFileSync(txtFile, 'utf-8').trim()
      try { fs.unlinkSync(txtFile) } catch {}
      return text || null
    }

    // Fallback: stdout
    if (stdout && stdout.trim()) return stdout.trim()
    return null
  } catch (e) {
    return null
  }
}

module.exports = { transcribeVoice, transcribeFile }
