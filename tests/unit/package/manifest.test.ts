import { readFile } from "node:fs/promises"
import { describe, expect, it } from "vitest"
import { z } from "zod"

const manifestSchema = z.object({
  name: z.string(),
  private: z.boolean().optional(),
  license: z.string().optional(),
  engines: z.object({ bun: z.string() }).optional(),
  bin: z.record(z.string(), z.string()).optional(),
  files: z.array(z.string()).optional(),
})

describe("package manifest", () => {
  it("publishes the Bun-native aibr command", async () => {
    // Given
    const manifest = manifestSchema.parse(JSON.parse(await readFile(new URL("../../../package.json", import.meta.url), "utf8")))

    // When
    const packageContract = {
      name: manifest.name,
      isPrivate: manifest.private ?? false,
      license: manifest.license,
      bun: manifest.engines?.bun,
      bin: manifest.bin?.aibr,
      files: manifest.files,
    }

    // Then
    expect(packageContract).toEqual({
      name: "@nyugennguyen/aibridge",
      isPrivate: false,
      license: "MIT",
      bun: ">=1.3.0",
      bin: "./dist/cli.js",
      files: ["dist", "bin", "README.md", "LICENSE"],
    })
  })
})
