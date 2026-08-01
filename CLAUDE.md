# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Project

ImgX Studio — a self-hosted Next.js WebUI for GPT Image / OpenAI-compatible image generation APIs (`gpt-image-2`, `gpt-image-2-2026-04-21`, `gpt-image-1`). Single-page app (`src/app/page.tsx` → `src/components/image-studio.tsx`) backed by one API route that proxies to an OpenAI-compatible images endpoint.

## Commands

```bash
npm run dev        # dev server with webpack (default)
npm run dev:turbo  # dev server with turbopack
npm run build       # production build (output: "standalone" in next.config.ts)
npm run start       # run the production build
npm run lint         # eslint (flat config, eslint.config.mjs)
```

There is no test suite configured in this repo.

## Important: this is not the Next.js you know

Per `AGENTS.md`, this project pins a Next.js version with breaking API/convention changes vs. training-data assumptions. Before writing Next.js-specific code (routing, `next/headers`, config, etc.), check `node_modules/next/dist/docs/` for the installed version's actual docs and heed deprecation notices rather than relying on prior knowledge of Next.js.

## Architecture

**Everything client-side lives in one component.** `src/components/image-studio.tsx` (~2500 lines) is a single `"use client"` component (`ImageStudio`) that owns all generation state (prompt, uploads, size/quality/format/background, connection settings, results, iteration/remix state) via `useState`. Locale-specific UI copy is defined in two large in-file dictionaries (`workflowCopies` for the remix/iteration panel, imported `studioMessages` for the rest) — when adding UI strings, add a key to every locale block in both `src/lib/i18n.ts` and `image-studio.tsx`'s `workflowCopies`, not just `en`.

**Request flow**: the browser always POSTs `FormData` to `/api/images` (`src/app/api/images/route.ts`), which forwards to the configured OpenAI-compatible endpoint using the `openai` SDK's `images.generate` / `images.edit`. The route picks `edit` vs `generate` based on whether reference images were attached. Note the README describes an optional "browser direct" mode, but the current implementation only exercises the server-proxy path — there is no client code that calls the image endpoint directly.

**Multi-image generation is N parallel single-image requests, not one `n=`-image request.** `handleSubmit` in `image-studio.tsx` fires up to `imageCount` (max 4) concurrent single-image calls to `/api/images` and streams results into state as each resolves, retrying failed slots up to `total + 2` attempts total. This is deliberate (see README: "reduce missing results from batch limits") — don't refactor it into a single `n=4` request.

**Size/quality/format allow-lists must stay in sync** between the client (`getSizeOptions`, `PRESET_SIZE_VALUES` etc. in `image-studio.tsx`) and the server (`GENERATE_SIZE_VALUES`, `EDIT_SIZE_VALUES`, `getGenerateQuality`/`getEditQuality` in `route.ts`) — edit and generate operations support different size sets. Custom sizes are validated against `MIN_CUSTOM_DIMENSION`/`MAX_CUSTOM_DIMENSION` (64–8192px) in both places.

**Response parsing is defensive by design.** `src/lib/image-request.ts`'s `extractGeneratedImages` recursively walks unknown response shapes (`data`, `images`, `output`, `content`, nested records) because different OpenAI-compatible providers return images under different keys/shapes. Keep new provider-compat handling in this file rather than in the route or component.

**i18n**: 9 locales (`en`, `zh`, `zh-TW`, `ja`, `ko`, `es`, `fr`, `de`, `pt`) defined in `src/lib/i18n.ts`. Locale resolution order is cookie (`imgx.locale`) → `Accept-Language` header → browser default, done server-side in `layout.tsx`/`page.tsx` and client-side via `useSyncExternalStore` in `image-studio.tsx`. Some locale objects use `...en` spread plus overrides (partial translations) — check whether a locale needs a full block or a spread before adding keys.

**Client-side persistence**: connection settings (API key, endpoint, remember toggle) are stored under `imgx.connectionPreferences` in `localStorage` only when the user opts in; there are legacy standalone keys (`imgx.apiKey`, `imgx.rememberKey`, `imgx.endpoint`) still read for migration. Locale preference is stored both as a cookie and in `localStorage` (`imgx.locale`).

**shadcn/ui**: components in `src/components/ui/` follow the `components.json` config (style `base-nova`, base color `neutral`, icon library `lucide`, no Tailwind prefix). Path aliases: `@/components`, `@/components/ui`, `@/lib`, `@/hooks` (see `tsconfig.json` `@/*` → `./src/*`).

## Environment variables

- `OPENAI_API_KEY` — optional server-side key for proxy mode; a key entered in the UI takes priority over this.
- `NEXT_ASSET_PREFIX` — optional static asset prefix for sub-path/CDN deploys (read in `next.config.ts`).

There is no `.env.example` file in the repo despite the README referencing one.
