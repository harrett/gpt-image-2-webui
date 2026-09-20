#!/usr/bin/env node

// 探测一个 OpenAI 兼容图片渠道「实际认账哪些参数」，而不是「哪些参数不报错」。
//
// 起因：image2pro 对 size / output_format / output_compression / response_format
// 一律返回 HTTP 200，然后全部忽略，固定产出 2880x2880 PNG 并以 URL 返回。只看状态
// 码会得出完全相反的结论，所以这里把「请求了什么」和「实收了什么」并排打出来。
//
// 结果用于填写 src/lib/image-model-capabilities.ts：某项为空数组 = 该模型不给用户
// 选择权，客户端隐藏控件、服务端省略字段。

const DEFAULT_BASE_URL = "https://api.image2pro.top/v1"
const DEFAULT_MODEL = "GPT-Image-2.5 0.01/张"
const DEFAULT_PROMPT = "a quiet bookstore at dawn, warm light"
// 刻意写成「只改一处、其余照搬」：如果上游真的用了参考图，结果应当明显脱胎于原图；
// 如果它把参考图丢掉直接按文字重画，结果会和原图毫无关系——这一点只有肉眼分得清。
const EDIT_PROMPT = "Keep this exact image and composition unchanged. Only tint the overall lighting warmer."
const DEFAULT_OUTPUT_DIR = "generated"
const PROBE_SIZE = "1536x1024"
const PROBE_FORMAT = "webp"
const PROBE_COMPRESSION = 80
// Cloudflare 按客户端签名拦截：Python urllib 会吃 403 error code 1010，
// 显式带一个正常 UA 就能过。
const USER_AGENT = "imgx-channel-probe/1.0"
const IMAGE_NAME_HINTS = ["image", "flux", "grok", "banana", "dall", "midjourney", "mj", "sd", "z-image"]

function printHelp() {
  console.log(`用法:
  IMAGE2PRO_API_KEY=sk-... npm run image2pro:probe             # 只跑免费探测（1、2）
  IMAGE2PRO_API_KEY=sk-... npm run image2pro:probe -- --generate  # 加跑付费探测（3、4）

探测项:
  1  GET  /models          该 Key 能看到的模型 ID（原样，不做大小写/空格处理）
  2  POST /images/edits    端点是否存在（空 body 400 = 存在；404/405 = 不存在）
  3  POST /images/generations  全参数发一发，看哪些被拒 —— 需要 --generate
  4  下载结果              实收的容器/尺寸/字节数，和请求的逐项对比 —— 需要 --generate

  5  POST /images/edits    带参考图真跑一发，把结果存盘供肉眼比对 —— 需要 --edit <图片>
                            端点存在不等于它会用你的参考图：这个上游已经被抓到
                            「200 但静默忽略参数」，忽略参考图属于同一类行为，
                            从状态码和响应结构上完全看不出来，只能看图。

选项:
      --generate            允许发起真实生成（会产生费用，默认约 0.01/张）
      --edit <图片路径>     用该图跑一发 edits（会产生费用），结果存到 --out-dir
      --out-dir <目录>      存放探测结果图片（默认: generated）
  -m, --model <模型>        探测用模型（默认: ${DEFAULT_MODEL}）
  -s, --size <宽x高>        探测请求的尺寸（默认: ${PROBE_SIZE}）
      --base-url <地址>     API 地址（默认: ${DEFAULT_BASE_URL}）
      --api-key <密钥>      API 密钥；更推荐 IMAGE2PRO_API_KEY 环境变量
      --json                额外输出机器可读的 JSON 汇总
  -h, --help                显示帮助

注意: 密钥只用于 Authorization 头，不会被打印、不会写入任何文件。`)
}

function parseArgs(argv) {
  const options = { model: DEFAULT_MODEL, size: PROBE_SIZE }
  const valueOptions = new Map([
    ["--model", "model"], ["-m", "model"], ["--size", "size"], ["-s", "size"],
    ["--base-url", "baseUrl"], ["--api-key", "apiKey"], ["--prompt", "prompt"],
    ["--edit", "edit"], ["--out-dir", "outDir"],
  ])

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--help" || arg === "-h") return { help: true }
    if (arg === "--generate") { options.generate = true; continue }
    if (arg === "--json") { options.json = true; continue }
    const key = valueOptions.get(arg)
    if (!key) throw new Error(`未知选项: ${arg}`)
    const value = argv[index + 1]
    if (!value || value.startsWith("-")) throw new Error(`${arg} 需要一个值`)
    options[key] = value
    index += 1
  }

  return options
}

function normalizeBaseUrl(value) {
  const url = new URL((value || DEFAULT_BASE_URL).replace(/\/+$/, ""))
  const path = url.pathname.replace(/\/+$/, "")
  if (path.endsWith("/images/generations") || path.endsWith("/images/edits")) {
    url.pathname = path.replace(/\/images\/(?:generations|edits)$/, "")
  } else if (!path || path === "/") {
    url.pathname = "/v1"
  }
  return url.toString().replace(/\/+$/, "")
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// 上游在 Cloudflare 后面，连续几发就会开始拒连（连接超时、TLS 握手被断）。那是
// 限流不是结论，重试掉，否则探测会把「网络抖动」报成「端点不存在」。
async function request(url, apiKey, init = {}, attempts = 3) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...init,
        headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": USER_AGENT, ...(init.headers || {}) },
      })
      const text = await response.text()
      let payload = null
      try { payload = text ? JSON.parse(text) : null } catch { payload = null }
      return { status: response.status, payload, text, headers: response.headers }
    } catch (error) {
      if (attempt >= attempts) {
        throw new Error(`${url} 连续 ${attempts} 次连接失败: ${error?.cause?.message || error.message}`)
      }
      await sleep(2000 * attempt)
    }
  }
}

function looksLikeImageModel(id) {
  const lower = String(id).toLowerCase()
  return IMAGE_NAME_HINTS.some((hint) => lower.includes(hint))
}

// PNG/JPEG/WebP 的尺寸都在头几十个字节里，不值得为此装依赖。
function inspectImage(buffer) {
  const bytes = new Uint8Array(buffer)
  const view = new DataView(buffer)

  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    return { container: "png", width: view.getUint32(16), height: view.getUint32(20) }
  }

  if (bytes.length > 30 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[8] === 0x57) {
    // VP8X/VP8L/VP8 各有各的布局；只处理最常见的有损 VP8。
    if (bytes[15] === 0x58) {
      const width = 1 + (bytes[24] | (bytes[25] << 8) | (bytes[26] << 16))
      const height = 1 + (bytes[27] | (bytes[28] << 8) | (bytes[29] << 16))
      return { container: "webp", width, height }
    }
    return { container: "webp" }
  }

  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let offset = 2
    while (offset + 9 < bytes.length) {
      if (bytes[offset] !== 0xff) { offset += 1; continue }
      const marker = bytes[offset + 1]
      const length = view.getUint16(offset + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { container: "jpeg", height: view.getUint16(offset + 5), width: view.getUint16(offset + 7) }
      }
      offset += 2 + length
    }
    return { container: "jpeg" }
  }

  return { container: "unknown" }
}

function megabytes(bytes) {
  return `${(bytes / 1048576).toFixed(1)}MB`
}

function verdict(requested, received) {
  if (received === undefined) return "无法判断"
  return String(requested) === String(received) ? "生效" : `被忽略（实收 ${received}）`
}

async function probeModels(baseUrl, apiKey, report) {
  console.log("\n── 探测 1: GET /models ─────────────────────────────")
  const { status, payload } = await request(`${baseUrl}/models`, apiKey)

  if (status !== 200 || !payload) {
    console.log(`  失败: HTTP ${status}`)
    report.models = { status, ids: [] }
    return
  }

  const list = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : []
  const ids = list.map((item) => (item && typeof item === "object" ? item.id ?? item.name : item))

  console.log(`  HTTP 200，共 ${ids.length} 个模型；疑似图像模型:`)
  for (const id of ids.filter(looksLikeImageModel)) {
    // JSON.stringify 保留空格、斜杠、中文的原样，配 model_mapping 时照抄即可。
    console.log(`    ${JSON.stringify(id)}`)
  }

  report.models = { status, ids }
}

async function probeEditsEndpoint(baseUrl, apiKey, report) {
  console.log("\n── 探测 2: POST /images/edits 是否存在 ──────────────")
  const edits = await request(`${baseUrl}/images/edits`, apiKey, { method: "POST" })
  await sleep(1000)
  const control = await request(`${baseUrl}/images/nonexistent-probe`, apiKey, { method: "POST" })
  const exists = edits.status !== 404 && edits.status !== 405

  console.log(`  /images/edits            -> HTTP ${edits.status}`)
  console.log(`  /images/nonexistent-probe -> HTTP ${control.status}  (对照组)`)
  console.log(`  判定: ${exists ? "端点存在" : "端点不存在"}`)

  report.edits = { status: edits.status, controlStatus: control.status, exists }
}

async function probeGeneration(baseUrl, apiKey, options, report) {
  console.log("\n── 探测 3: POST /images/generations（全参数）────────")
  const body = {
    model: options.model,
    prompt: options.prompt || DEFAULT_PROMPT,
    size: options.size,
    n: 1,
    response_format: "b64_json",
    output_format: PROBE_FORMAT,
    output_compression: PROBE_COMPRESSION,
    background: "auto",
    quality: "auto",
  }

  console.log(`  请求: model=${JSON.stringify(body.model)} size=${body.size} output_format=${body.output_format}`)
  console.log(`        output_compression=${body.output_compression} response_format=${body.response_format}`)

  const started = Date.now()
  const { status, payload, text } = await request(`${baseUrl}/images/generations`, apiKey, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)

  console.log(`  HTTP ${status}，耗时 ${elapsed}s`)

  if (status !== 200 || !payload) {
    console.log(`  响应: ${text.slice(0, 300)}`)
    console.log("  判定: 请求被拒——错误信息里点名的参数就是要从能力表里去掉的那个。")
    report.generation = { status, elapsed: Number(elapsed), error: text.slice(0, 300) }
    return null
  }

  const item = Array.isArray(payload.data) ? payload.data[0] : null
  const fields = item ? Object.keys(item) : []

  console.log(`  顶层字段: ${Object.keys(payload).join(", ")}`)
  console.log(`  data[0] 字段: ${fields.join(", ") || "（空）"}`)
  console.log(`  判定: 全部参数被接受（是否生效见探测 4）`)

  report.generation = { status, elapsed: Number(elapsed), dataFields: fields, requested: body }
  return item
}

async function probeDelivery(item, options, report) {
  console.log("\n── 探测 4: 实收内容 ────────────────────────────────")

  if (!item) {
    console.log("  跳过：探测 3 没有拿到结果")
    return
  }

  if (item.b64_json && !item.url) {
    console.log("  返回形式: b64_json（无需网关回填）")
  } else if (item.url) {
    console.log("  返回形式: url —— 浏览器直接拿到这个地址会泄漏上游域名，需服务端内联")
  }

  const source = item.url || (item.b64_json ? `data:;base64,${item.b64_json}` : null)

  if (!source) {
    console.log("  无法取回图片：既没有 url 也没有 b64_json")
    return
  }

  const buffer = item.url
    ? await (await fetch(item.url, { headers: { "User-Agent": USER_AGENT } })).arrayBuffer()
    : Buffer.from(item.b64_json, "base64").buffer
  const info = inspectImage(buffer)
  const received = info.width && info.height ? `${info.width}x${info.height}` : undefined

  console.log(`  容器: ${info.container}    尺寸: ${received ?? "未知"}    体积: ${megabytes(buffer.byteLength)}`)
  console.log(`  base64 回传后约 ${megabytes(Math.ceil(buffer.byteLength / 3) * 4)}`)
  console.log("")
  console.log(`  size              请求 ${options.size} -> ${verdict(options.size, received)}`)
  console.log(`  output_format     请求 ${PROBE_FORMAT} -> ${verdict(PROBE_FORMAT, info.container)}`)
  console.log(`  response_format   请求 b64_json -> ${item.b64_json ? "生效" : "被忽略（返回 url）"}`)
  console.log(`  output_compression 请求 ${PROBE_COMPRESSION} -> ${info.container === "png" ? "无从生效（PNG 不吃该参数）" : "需对比两次体积才能判定"}`)

  report.delivery = {
    container: info.container,
    size: received,
    bytes: buffer.byteLength,
    returnedAs: item.url ? "url" : "b64_json",
  }
}

async function probeEditRoundTrip(baseUrl, apiKey, options, report) {
  console.log("\n── 探测 5: edits 是否真的用了参考图 ────────────────")

  const { basename, extname, join } = await import("node:path")
  const { mkdir, readFile, writeFile } = await import("node:fs/promises")

  const referenceBytes = await readFile(options.edit)
  const extension = extname(options.edit).toLowerCase()
  const mimeType = extension === ".png" ? "image/png"
    : extension === ".webp" ? "image/webp"
    : extension === ".jpg" || extension === ".jpeg" ? "image/jpeg"
    : null

  if (!mimeType) throw new Error(`--edit 只支持 png / jpg / webp，收到: ${extension || "无扩展名"}`)

  const reference = inspectImage(referenceBytes.buffer.slice(
    referenceBytes.byteOffset,
    referenceBytes.byteOffset + referenceBytes.byteLength
  ))

  console.log(`  参考图: ${basename(options.edit)}  ${reference.container} ${reference.width ?? "?"}x${reference.height ?? "?"}  ${megabytes(referenceBytes.byteLength)}`)
  console.log(`  提示词: "${EDIT_PROMPT}"`)

  const form = new FormData()
  form.append("model", options.model)
  form.append("prompt", EDIT_PROMPT)
  form.append("n", "1")
  form.append("image", new Blob([referenceBytes], { type: mimeType }), basename(options.edit))

  const started = Date.now()
  const { status, payload, text } = await request(`${baseUrl}/images/edits`, apiKey, {
    method: "POST",
    body: form,
  })
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)

  console.log(`  HTTP ${status}，耗时 ${elapsed}s`)

  const item = status === 200 && Array.isArray(payload?.data) ? payload.data[0] : null

  if (!item) {
    console.log(`  响应: ${text.slice(0, 300)}`)
    console.log("  判定: edits 不可用——画布改图链路在这个渠道上跑不通。")
    report.edit = { status, elapsed: Number(elapsed), usable: false }
    return
  }

  const buffer = item.url
    ? await (await fetch(item.url, { headers: { "User-Agent": USER_AGENT } })).arrayBuffer()
    : Buffer.from(item.b64_json, "base64").buffer
  const result = inspectImage(buffer)
  const outDir = options.outDir || DEFAULT_OUTPUT_DIR

  await mkdir(outDir, { recursive: true })
  const outPath = join(outDir, `probe-edit-${Date.now()}.${result.container === "unknown" ? "bin" : result.container}`)
  await writeFile(outPath, Buffer.from(buffer))

  console.log(`  结果: ${result.container} ${result.width ?? "?"}x${result.height ?? "?"}  ${megabytes(buffer.byteLength)}`)
  console.log(`  已存盘: ${outPath}`)
  console.log("")
  console.log("  ⚠ 这一项没有自动判定，必须肉眼比对：")
  console.log(`     打开 ${outPath} 和 ${options.edit}`)
  console.log("     脱胎于原图  -> edits 真的用了参考图，画布改图可用")
  console.log("     毫无关系    -> 参考图被静默丢弃，只是照文字重画了一张")

  report.edit = {
    status,
    elapsed: Number(elapsed),
    usable: true,
    container: result.container,
    size: result.width && result.height ? `${result.width}x${result.height}` : undefined,
    bytes: buffer.byteLength,
    savedTo: outPath,
    referencePath: options.edit,
  }
}

function printSummary(report, options) {
  console.log("\n── 该填进 image-model-capabilities.ts 的结论 ────────")

  if (!report.delivery) {
    console.log("  （未跑付费探测，参数是否生效未知；加 --generate 再跑一次）")
    return
  }

  const honoursSize = report.delivery.size === options.size
  const honoursFormat = report.delivery.container === PROBE_FORMAT

  console.log(`  generateSizes:   ${honoursSize ? "保留尺寸列表" : "[]  ← 模型自己定尺寸，UI 应隐藏 aspect 控件"}`)
  console.log(`  outputFormats:   ${honoursFormat ? "保留格式列表" : "[]  ← 模型自己定容器，UI 应隐藏 format 控件"}`)
  console.log(`  editSizes:       ${
    report.edits?.exists
      ? report.edit?.usable
        ? "同 generateSizes（edits 端点存在且返回了图，参考图是否被采纳见探测 5 的肉眼比对）"
        : "端点存在，但未验证它是否真的会用参考图 —— 跑 --edit 再定"
      : "[]  ← 没有 edits 端点"
  }`)
  console.log(`  服务端内联上限:   本次实收 ${megabytes(report.delivery.bytes)}；上限比的是原始字节数，不是 base64 后的体积`)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) { printHelp(); return }

  const apiKey = options.apiKey || process.env.IMAGE2PRO_API_KEY
  if (!apiKey) throw new Error("缺少 API 密钥，请设置 IMAGE2PRO_API_KEY 环境变量")
  const baseUrl = normalizeBaseUrl(options.baseUrl || process.env.IMAGE2PRO_API_BASE_URL)

  console.log(`探测目标: ${baseUrl}`)
  console.log(`付费探测: ${options.generate ? "开启（将产生费用）" : "关闭（加 --generate 开启）"}`)

  const report = {}

  await probeModels(baseUrl, apiKey, report)
  await probeEditsEndpoint(baseUrl, apiKey, report)

  if (options.generate) {
    const item = await probeGeneration(baseUrl, apiKey, options, report)
    await probeDelivery(item, options, report)
  } else {
    console.log("\n── 探测 3、4 已跳过 ────────────────────────────────")
    console.log("  这两项需要真实生成一张图（约 0.01/张）。确认后加 --generate 重跑。")
  }

  if (options.edit) {
    await probeEditRoundTrip(baseUrl, apiKey, options, report)
  } else {
    console.log("\n── 探测 5 已跳过 ──────────────────────────────────")
    console.log("  加 --edit <图片路径> 验证 edits 是否真的会用参考图（同样产生费用）。")
  }

  printSummary(report, options)

  if (options.json) {
    console.log(`\n${JSON.stringify(report, null, 2)}`)
  }
}

main().catch((error) => {
  console.error(`错误: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
