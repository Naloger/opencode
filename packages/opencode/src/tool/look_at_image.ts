import z from "zod"
import * as path from "path"
import { stat, readFile } from "fs/promises"
import { Tool } from "./tool"
import DESCRIPTION from "./look_at_image.txt"
import { Instance } from "../project/instance"
import { assertExternalDirectory } from "./external-directory"
import { AppFileSystem } from "@/filesystem"

const parameters = z.object({
  filePath: z.string().describe("Absolute path to the image file to inspect"),
})

function trim(input: string) {
  return input.trim().replace(/^['\"]+|['\"]+$/g, "")
}

function key(input: string) {
  const hit = trim(input).match(/^\[?image\s+(\d+)\]?$/i)
  if (!hit) return
  return `image ${hit[1]}`
}

function pick(input: string, msgs: Tool.Context["messages"]) {
  const raw = trim(input)
  const ref = key(raw)

  for (let i = msgs.length - 1; i >= 0; i--) {
    const msg = msgs[i]
    for (let j = msg.parts.length - 1; j >= 0; j--) {
      const part = msg.parts[j]
      if (part.type !== "file") continue

      const src = part.source
      if (src?.type !== "file") continue

      const tag = trim(src.text.value).replace(/^\[|\]$/g, "").toLowerCase()
      if (ref && tag === ref) return src.path

      if (!ref && trim(src.text.value).toLowerCase() === raw.toLowerCase()) return src.path
      if (!ref && path.basename(src.path).toLowerCase() === raw.toLowerCase()) return src.path
    }
  }

  return input
}

export const LookAtImageTool = Tool.define("look_at_image", {
  description: DESCRIPTION,
  parameters,
  async execute(params, ctx) {
    const mdl = ctx.extra?.model as
      | {
          capabilities?: {
            input?: {
              image?: boolean
            }
          }
        }
      | undefined
    const can = mdl?.capabilities?.input?.image

    const raw = params.filePath
    let file = path.isAbsolute(raw) ? raw : pick(raw, ctx.messages)
    if (!path.isAbsolute(file)) {
      file = path.resolve(Instance.directory, file)
    }
    if (process.platform === "win32") {
      file = AppFileSystem.normalizePath(file)
    }

    const info = await stat(file).catch(() => undefined)
    await assertExternalDirectory(ctx, file, { kind: info?.isDirectory() ? "directory" : "file" })

    await ctx.ask({
      permission: "read",
      patterns: [file],
      always: ["*"],
      metadata: {
        mode: "image_inspection",
        filePath: file,
      },
    })

    if (!info) {
      const ref = key(raw)
      if (ref) {
        throw new Error(
          `File not found: ${file}\n\nCould not resolve image reference \"${raw}\" to a local file path. Pass an absolute path or ensure the image exists in this session attachments.`,
        )
      }
      throw new Error(`File not found: ${file}`)
    }
    if (info.isDirectory()) {
      throw new Error(`Expected an image file, but got directory: ${file}`)
    }

    const mime = AppFileSystem.mimeType(file)
    if (!mime.startsWith("image/") || mime === "image/svg+xml" || mime === "image/vnd.fastbidsheet") {
      throw new Error(`Expected an image file, but got MIME type: ${mime}. Supported formats: JPEG, PNG, WebP, GIF, AVIF, BMP.`)
    }

    const data = await readFile(file)
    const b64 = Buffer.from(data).toString("base64")
    const title = path.relative(Instance.worktree, file)
    const note =
      can === false
        ? "\n\nNote: Model capability metadata says image input is unsupported, but image was attached anyway."
        : ""

    return {
      title,
      output: `Image loaded and attached: ${title}\n\nThe model can now analyze the image contents. Describe what you'd like me to look for or extract.${note}`,
      metadata: {
        mime,
        filePath: file,
        truncated: false,
        capability_image: can,
      },
      attachments: [
        {
          type: "file" as const,
          mime,
          url: `data:${mime};base64,${b64}`,
        },
      ],
    }
  },
})
