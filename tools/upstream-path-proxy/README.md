# upstream-path-proxy

把 `/v1/*` 重写成 `{UPSTREAM_BASE_URL}/*` 的透传反代。独立进程，不属于 Next.js 应用。

## 解决什么问题

sub2api 拼上游 URL 的规则是「base URL + 规范端点」，只有当 base URL 最后一段看起来像版本号（`v1`、`v1beta`…）时才省略 `/v1`。所以把 OpenAI 兼容接口挂在非版本号前缀下的上游接不进去：

```
渠道 base: https://image.aigw.store/api-proxy
sub2api 请求: https://image.aigw.store/api-proxy/v1/images/generations   → 404
上游实际端点: https://image.aigw.store/api-proxy/images/generations      → 200
```

差的是中间那段 `/v1`，得**删掉**而不是挪位置，靠改 base URL 拼不出来。这个反代插在中间，只做一件事：剥掉路径前缀，其余原样转发。

```
sub2api 渠道 base URL: http://127.0.0.1:9090
  收到  POST /v1/images/generations
  转发  POST https://image.aigw.store/api-proxy/images/generations
```

sub2api 的 `base_url_skip_version` 开关发版后，这一层就可以摘掉 —— 把渠道 base URL 改回 `https://image.aigw.store/api-proxy` 并勾上开关即可。

## 用法

```bash
UPSTREAM_BASE_URL=https://image.aigw.store/api-proxy \
node tools/upstream-path-proxy/server.mjs
```

或用 npm script：

```bash
UPSTREAM_BASE_URL=https://image.aigw.store/api-proxy npm run proxy:upstream
```

然后把 sub2api 的渠道 Base URL 改成 `http://127.0.0.1:9090`，API Key 保持上游那把不变。

## 配置

| 变量 | 默认 | 说明 |
|---|---|---|
| `UPSTREAM_BASE_URL` | 无，**必填** | 上游真实前缀，例 `https://image.aigw.store/api-proxy` |
| `PORT` | `9090` | 监听端口 |
| `HOST` | `127.0.0.1` | 监听地址。默认只回环，改成 `0.0.0.0` 前先想清楚暴露面 |
| `STRIP_PREFIX` | `/v1` | 要剥掉的前缀。设为空字符串则纯转发不改路径 |
| `UPSTREAM_TIMEOUT_MS` | `600000` | 上游超时。生图常跑 30-120s，不要调太小 |

`GET /healthz` 返回 `{"ok":true,...}`，可用于探活。

## 设计约束

- **不持有任何凭据。** `Authorization` 从入站请求原样透传，本进程没有自己的 key，因此也没有可泄漏的 key。
- **不缓冲。** 请求体和响应体都是 `pipe`，multipart 上传不会被攒进内存，将来若启用 `partial_images` 流式（SSE）也不会被拖到最后一次性吐出。
- **不是开放代理。** 默认绑回环；`STRIP_PREFIX` 之外的路径一律 404，不能被用来转发任意上游地址。
- **不改 body。** 只动路径和 hop-by-hop 头，请求体逐字节透传。

## 已知边界

- 只处理 HTTP/1.1。上游若强制 HTTP/2 需要另外处理。
- 日志只打 method、路径、状态码、耗时，**不打任何 header** —— Authorization 会流经此处。
- 单进程无重试。上游连接失败返回 502，超时返回 502 并在日志留痕；重试交给调用方（sub2api 有自己的故障转移）。
