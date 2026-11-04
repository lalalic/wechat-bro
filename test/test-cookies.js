'use strict'
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const cli = fs.readFileSync(path.join(__dirname, '../src/cli.js'),'utf8')
assert(!cli.includes('page.setCookie'), 'legacy cookies are not imported')
assert(!cli.includes('cookies.json'), 'browser cookies are no longer exported to ~/.wechat-bro')
assert(!cli.includes('PUPPETEER_CACHE_DIR'), 'no second browser profile')
console.log('cookies: WebHelm managed Chrome profile owns authentication state')
