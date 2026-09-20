#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"

const DEFAULT_BASE_URL = "https://api.image2pro.top/v1"
const DEFAULT_MODEL = "GPT-Image-2"
const DEFAULT_SIZE = "1024x1024"
const DEFAULT_OUTPUT_DIR = "generated"

function printHelp() {
  console.log(`用法:
  IMAGE2PRO_API_KEY=sk-... npm run image2pro -- --prompt "一间被晨光照亮的书店"

选项:
  -p, --prompt <文本>       图片提示词（必填，--list-models 除外）
  -m, --model <模型>        模型 ID（默认: ${DEFAULT_MODEL}）
  -s, --size <宽x高>        图片尺寸（默认: ${DEFAULT_SIZE}）
  -n, --count <数量>        生成数量，1-4（默认: 1）
      --quality <值>        auto、low、medium、high 或 standard
      --background <值>     auto、opaque 或 transparent
      --format <格式>       png、jpeg 或 webp（默认: png）
  -o, --output-dir <目录>   输出目录（默认: ${DEFAULT_OUTPUT_DIR}）
      --base-url <地址>     API 地址（默认: ${DEFAULT_BASE_URL}）
      --api-key <密钥>      API 密钥；更推荐使用 IMAGE2PRO_API_KEY 环境变量
      --list-models         列出当前密钥可用模型
  -h, --help                显示帮助

示例:
  IMAGE2PRO_API_KEY=sk-... npm run image2pro -- \\
    --prompt "一只戴飞行员眼镜的柴犬，电影海报风格" \\
    --model "Grok-image-2.0" --size 1024x1024 --count 2`)
}

function parseArgs(argv) {
  const options = { count: 1, size: DEFAULT_SIZE, model: DEFAULT_MODEL, outputDir: DEFAULT_OUTPUT_DIR, format: "png" }
  const valueOptions = new Map([
    ["--prompt", "prompt"], ["-p", "prompt"], ["--model", "model"], ["-m", "model"],
    ["--size", "size"], ["-s", "size"], ["--count", "count"], ["-n", "count"],
    ["--quality", "quality"], ["--background", "background"], ["--format", "format"],
    ["--output-dir", "outputDir"], ["-o", "outputDir"], ["--base-url", "baseUrl"],
    ["--api-key", "apiKey"],
  ])

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--help" || arg === "-h") return { help: true }
    if (arg === "--list-models") { options.listModels = true; continue }
    const key = valueOptions.get(arg)
    if (!key) throw new Error(`未知选项: ${arg}`)
    const value = argv[index + 1]
    if (!value || value.startsWith("-")) throw new Error(`${arg} 需要一个值`)
    options[key] = value
    index += 1
  }

  return options
}

function numberInRange(value, name, min, max) {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} 必须是 ${min}-${max} 的整数`)
  }
  return parsed
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

function errorMessage(payload, status) {
  const error = payload?.error
  return error?.message || (typeof error === "string" ? error : null) || payload?.message || `请求失败（HTTP ${status}）`
}

function imageEntries(payload) {
  const data = Array.isArray(payload?.data) ? payload.data : []
  return data.flatMap((item) => {
    if (typeof item === "string") return [{ value: item }]
    if (!item || typeof item !== "object") return []
    const value = item.b64_json || item.base64 || item.url || item.image
    return value ? [{ value, revisedPrompt: item.revised_prompt }] : []
  })
}

function extensionFor(format, value) {
  if (format === "jpeg") return "jpg"
  if (format === "webp") return "webp"
  if (/^data:image\/jpeg/i.test(value)) return "jpg"
  if (/^data:image\/webp/i.test(value)) return "webp"
  return "png"
}

async function saveImage(value, outputPath) {
  if (/^https?:\/\//i.test(value)) {
    const response = await fetch(value)
    if (!response.ok) throw new Error(`下载图片失败（HTTP ${response.status}）`)
    await writeFile(outputPath, Buffer.from(await response.arrayBuffer()))
    return
  }

  const base64 = value.replace(/^data:image\/[^;]+;base64,/, "")
  await writeFile(outputPath, Buffer.from(base64, "base64"))
}

async function requestJson(url, apiKey, init = {}) {
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, ...(init.headers || {}) },
  })
  const text = await response.text()
  let payload
  try { payload = text ? JSON.parse(text) : {} } catch { payload = { message: text.slice(0, 500) } }
  if (!response.ok) throw new Error(errorMessage(payload, response.status))
  return payload
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.help) { printHelp(); return }

  const apiKey = options.apiKey || process.env.IMAGE2PRO_API_KEY
  if (!apiKey) throw new Error("缺少 API 密钥，请设置 IMAGE2PRO_API_KEY 环境变量")
  const baseUrl = normalizeBaseUrl(options.baseUrl || process.env.IMAGE2PRO_API_BASE_URL)

  if (options.listModels) {
    const payload = await requestJson(`${baseUrl}/models`, apiKey)
    const models = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : []
    if (!models.length) { console.log(JSON.stringify(payload, null, 2)); return }
    for (const model of models) console.log(`${model.id || model.name || model}`)
    return
  }

  if (!options.prompt?.trim()) throw new Error("请提供 --prompt")
  const count = numberInRange(options.count, "--count", 1, 4)
  if (!/^\d{2,5}x\d{2,5}$/.test(options.size)) throw new Error("--size 必须类似 1024x1024")
  if (!["png", "jpeg", "webp"].includes(options.format)) throw new Error("--format 必须是 png、jpeg 或 webp")
  if (options.quality && !["auto", "low", "medium", "high", "standard"].includes(options.quality)) {
    throw new Error("--quality 值无效")
  }
  if (options.background && !["auto", "opaque", "transparent"].includes(options.background)) throw new Error("--background 值无效")

  const body = {
    model: options.model,
    prompt: options.prompt.trim(),
    size: options.size,
    n: count,
    response_format: "b64_json",
    output_format: options.format,
    ...(options.quality ? { quality: options.quality } : {}),
    ...(options.background ? { background: options.background } : {}),
  }

  console.log(`正在请求 ${body.model}，生成 ${count} 张图片...`)
  const payload = await requestJson(`${baseUrl}/images/generations`, apiKey, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  const entries = imageEntries(payload)
  if (!entries.length) throw new Error("API 响应中没有图片数据")

  await mkdir(options.outputDir, { recursive: true })
  const saved = []
  for (const [index, entry] of entries.entries()) {
    const extension = extensionFor(options.format, entry.value)
    const outputPath = join(options.outputDir, `image-${Date.now()}-${index + 1}.${extension}`)
    await saveImage(entry.value, outputPath)
    saved.push(outputPath)
    console.log(`已保存: ${outputPath}`)
  }
  return saved
}

main().catch((error) => {
  console.error(`错误: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
