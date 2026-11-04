'use strict'
const assert=require('node:assert/strict')
const fs=require('node:fs')
const os=require('node:os')
const path=require('node:path')
;(async()=>{
const root=fs.mkdtempSync(path.join(os.tmpdir(),'wechat-async-stt-test-'))
try{
  const stub=path.join(root,'stub-uvx')
  fs.writeFileSync(stub,[
    '#!/bin/sh',
    'outdir=""',
    'input=""',
    'while [ "$#" -gt 0 ]; do',
    '  if [ "$1" = "--output_dir" ]; then shift; outdir="$1";',
    '  elif [ -f "$1" ]; then input="$1"; fi',
    '  shift',
    'done',
    'sleep 1',
    'base=$(basename "$input")',
    'stem=$(echo "$base" | sed "s/\\.[^.]*$//")',
    'printf "voice fixture verified" > "$outdir/$stem.txt"',
  ].join('\n')+'\n')
  fs.chmodSync(stub,0o755)
  process.env.UVX_CMD=stub
  process.env.WHISPER_TIMEOUT='5000'
  const {transcribeFileAsync,transcribeVoiceAsync}=require('../src/transcribe')
  const file=path.join(root,'fixture.wav')
  fs.writeFileSync(file,Buffer.alloc(256,0x52))
  let ticker=false
  setTimeout(()=>{ticker=true},100)
  const text=await transcribeFileAsync(file)
  assert.equal(text,'voice fixture verified')
  assert(ticker,'async STT must not block node event loop/heartbeat')
  const voice={voiceBase64:Buffer.alloc(256,0x52).toString('base64')}
  assert(await transcribeVoiceAsync(voice))
  assert.equal(voice.voiceText,'voice fixture verified')
  console.log('Async STT: file + inbound base64, no event-loop block PASS')
}finally{fs.rmSync(root,{recursive:true,force:true})}
})().catch(e=>{console.error(e.stack||e.message);process.exitCode=1})