import {
  App,
  Editor,
  MarkdownView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
} from "obsidian";


// ---------------- Settings ----------------

interface InlineB64Settings {
  enableForPaste: boolean;
  enableForDrop: boolean;
  maxInlineKB: number;              // 0 = unlimited
  allowMimes: string[];             // e.g., ["image/png", "image/jpeg", "image/gif", "image/webp"]
  reencodeToJPEG: boolean;          // if true, re-encode clipboard image to JPEG
  jpegQuality: number;              // 0.1..1.0
  insertAltFromFileName: boolean;   // try to use clipboard file name as alt text
  convertRemoteImageURLs: boolean;  // if paste is a URL to an image, fetch → inline
  timeoutMs: number;                // guardrail for fetch/convert
}

const DEFAULT_SETTINGS: InlineB64Settings = {
  enableForPaste: true,
  enableForDrop: true,
  maxInlineKB: 0,
  allowMimes: ["image/png", "image/jpeg", "image/gif", "image/webp"],
  reencodeToJPEG: false,
  jpegQuality: 0.9,
  insertAltFromFileName: true,
  convertRemoteImageURLs: false,
  timeoutMs: 15_000,
};

export default class InlineB64Plugin extends Plugin {
  settings: InlineB64Settings;

  async onload() {
    await this.loadSettings();
    this.addSettingTab(new InlineB64SettingTab(this.app, this));

    // Handle paste
    this.registerEvent(
      this.app.workspace.on(
        "editor-paste",
        async (evt: ClipboardEvent, editor: Editor, view: MarkdownView) => {
          if (!this.settings.enableForPaste) return;
          try {
            await this.tryHandleClipboardEvent(evt, editor);
          } catch (e) {
            console.error(e);
            new Notice("Inline Base64: paste failed (see console).");
          }
        }
      )
    );

    // Handle drag & drop (optional)
    this.registerEvent(
      this.app.workspace.on(
        "editor-drop",
        async (evt: DragEvent, editor: Editor, view: MarkdownView) => {
          if (!this.settings.enableForDrop) return;
          try {
            await this.tryHandleDropEvent(evt, editor);
          } catch (e) {
            console.error(e);
            new Notice("Inline Base64: drop failed (see console).");
          }
        }
      )
    );
  }

  async onunload() {}

  // ---------- Core logic ----------

  private async tryHandleClipboardEvent(
    evt: ClipboardEvent,
    editor: Editor
  ): Promise<boolean> {
    const cd = evt.clipboardData;
    if (!cd) return false;

    // 1) Image files directly on clipboard
    const files = Array.from(cd.files ?? []).filter((f) =>
      f.type.startsWith("image/")
    );
    if (files.length > 0) {
      this.swallowEvent(evt);
      const inserts = await this.convertFilesToDataUrls(files);
      if (inserts.length === 0) return false;
      this.insertMarkdownImages(editor, inserts);
      return true;
    }

    // 2) Optional: if clipboard is text → URL pointing to image, fetch & inline
    if (this.settings.convertRemoteImageURLs) {
      const text = cd.getData("text/plain")?.trim();
      if (text && isLikelyImageURL(text)) {
        this.swallowEvent(evt);
        const abort = new AbortController();
        const to = setTimeout(() => abort.abort(), this.settings.timeoutMs);
        try {
          const res = await fetch(text, { signal: abort.signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const ct = res.headers.get("content-type") || "";
          if (!ct.startsWith("image/")) return false;
          const blob = await res.blob();
          const dataUrl = await this.blobToDataUrl(blob, ct);
          this.insertMarkdownImages(editor, [
            { alt: fileNameFromURL(text), dataUrl },
          ]);
          return true;
        } finally {
          clearTimeout(to);
        }
      }
    }

    // 3) Some apps put HTML with inline <img src="data:..."> — let Obsidian handle it.
    return false;
  }

  private async tryHandleDropEvent(
    evt: DragEvent,
    editor: Editor
  ): Promise<boolean> {
    const dt = evt.dataTransfer;
    if (!dt) return false;
    const files = Array.from(dt.files ?? []).filter((f) =>
      f.type.startsWith("image/")
    );
    if (files.length === 0) return false;
    this.swallowEvent(evt);
    const inserts = await this.convertFilesToDataUrls(files);
    if (inserts.length === 0) return false;
    this.insertMarkdownImages(editor, inserts);
    return true;
  }

  private swallowEvent(evt: Event) {
    evt.preventDefault();
    evt.stopPropagation();
    (evt as ClipboardEvent | DragEvent).stopImmediatePropagation?.();
  }

  private async convertFilesToDataUrls(
    files: File[]
  ): Promise<Array<{ alt: string; dataUrl: string }>> {
    const out: Array<{ alt: string; dataUrl: string }> = [];
    for (const f of files) {
      if (!this.settings.allowMimes.some((m) => f.type === m)) {
        // Skip disallowed MIME types quietly
        continue;
      }

      let blob: Blob = f;
      let mime = f.type;

      if (this.settings.reencodeToJPEG && mime !== "image/jpeg") {
        try {
          const jpegBlob = await reencodeImageToJPEG(f, this.settings.jpegQuality);
          blob = jpegBlob;
          mime = "image/jpeg";
        } catch (e) {
          console.warn("JPEG re-encode failed; falling back to original", e);
        }
      }

      const dataUrl = await this.blobToDataUrl(blob, mime);

      // Size guard (after re-encode if enabled)
      if (this.settings.maxInlineKB > 0) {
        const approxBytes = roughDataUrlSizeBytes(dataUrl);
        if (approxBytes > this.settings.maxInlineKB * 1024) {
          new Notice(
            `Inline Base64: ${f.name} is ${Math.round(
              approxBytes / 1024
            )}KB > limit (${this.settings.maxInlineKB}KB). Skipped.`
          );
          continue;
        }
      }

      out.push({
        alt: this.settings.insertAltFromFileName ? stripExt(f.name) : "",
        dataUrl,
      });
    }
    return out;
  }

  private insertMarkdownImages(
    editor: Editor,
    inserts: Array<{ alt: string; dataUrl: string }>
  ) {
    // Insert each image on its own line
    const lines = inserts.map(
      (x) => `![${escapeMarkdownAlt(x.alt)}](${x.dataUrl})`
    );
    const text = lines.join("\n");
    editor.replaceSelection(text);
  }

  private blobToDataUrl(blob: Blob, fallbackMime?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onerror = () => reject(fr.error);
      fr.onload = () => {
        const result = fr.result;
        if (typeof result !== "string") {
          reject(new Error("Unexpected FileReader result"));
          return;
        }
        // Ensure data URL has mime. Some environments infer it; we enforce.
        if (!result.startsWith("data:") && fallbackMime) {
          const base64 = result.split(",")[1] ?? "";
          resolve(`data:${fallbackMime};base64,${base64}`);
        } else {
          resolve(result);
        }
      };
      fr.readAsDataURL(blob);
    });
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
}

// ---------------- Settings tab ----------------

class InlineB64SettingTab extends PluginSettingTab {
  plugin: InlineB64Plugin;

  constructor(app: App, plugin: InlineB64Plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Inline Images as Base64" });

    new Setting(containerEl)
      .setName("Enable for paste")
      .setDesc("Intercept CTRL/CMD+V and inline images as Base64.")
      .addToggle((tg) =>
        tg
          .setValue(this.plugin.settings.enableForPaste)
          .onChange(async (v) => {
            this.plugin.settings.enableForPaste = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Enable for drag & drop")
      .setDesc("Intercept image file drops and inline as Base64.")
      .addToggle((tg) =>
        tg
          .setValue(this.plugin.settings.enableForDrop)
          .onChange(async (v) => {
            this.plugin.settings.enableForDrop = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Max inline size (KB)")
      .setDesc("0 = unlimited. Images larger than this are skipped.")
      .addText((txt) =>
        txt
          .setPlaceholder("0")
          .setValue(String(this.plugin.settings.maxInlineKB))
          .onChange(async (v) => {
            const n = Number(v);
            this.plugin.settings.maxInlineKB = Number.isFinite(n) && n >= 0 ? n : 0;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Allow MIME types")
      .setDesc("Comma-separated list (e.g. image/png,image/jpeg,image/webp).")
      .addText((txt) =>
        txt
          .setValue(this.plugin.settings.allowMimes.join(","))
          .onChange(async (v) => {
            this.plugin.settings.allowMimes = v
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Re-encode to JPEG")
      .setDesc("Convert pasted images to JPEG to shrink size.")
      .addToggle((tg) =>
        tg
          .setValue(this.plugin.settings.reencodeToJPEG)
          .onChange(async (v) => {
            this.plugin.settings.reencodeToJPEG = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("JPEG quality")
      .setDesc("Used only if re-encode is on (0.1–1.0).")
      .addText((txt) =>
        txt
          .setPlaceholder("0.9")
          .setValue(String(this.plugin.settings.jpegQuality))
          .onChange(async (v) => {
            let q = Number(v);
            if (!Number.isFinite(q)) q = 0.9;
            q = Math.min(1, Math.max(0.1, q));
            this.plugin.settings.jpegQuality = q;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Use filename as alt text")
      .setDesc("If available, strip extension and use as Markdown alt.")
      .addToggle((tg) =>
        tg
          .setValue(this.plugin.settings.insertAltFromFileName)
          .onChange(async (v) => {
            this.plugin.settings.insertAltFromFileName = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Convert remote image URLs on paste")
      .setDesc("If clipboard is an image URL, fetch and inline as Base64.")
      .addToggle((tg) =>
        tg
          .setValue(this.plugin.settings.convertRemoteImageURLs)
          .onChange(async (v) => {
            this.plugin.settings.convertRemoteImageURLs = v;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Network/convert timeout (ms)")
      .setDesc("Guardrail timeout for remote fetch and conversions.")
      .addText((txt) =>
        txt
          .setPlaceholder("15000")
          .setValue(String(this.plugin.settings.timeoutMs))
          .onChange(async (v) => {
            const n = Number(v);
            this.plugin.settings.timeoutMs = Number.isFinite(n) && n > 0 ? n : 15000;
            await this.plugin.saveSettings();
          })
      );
  }
}

// ---------------- Helpers ----------------

function roughDataUrlSizeBytes(dataUrl: string): number {
  // “data:mime;base64,AAA...” → length after the comma is base64 chars
  const idx = dataUrl.indexOf(",");
  if (idx < 0) return dataUrl.length;
  const b64len = dataUrl.length - (idx + 1);
  // Base64 is 4 chars per 3 bytes; reverse that.
  return Math.floor((b64len * 3) / 4);
}

function stripExt(name: string): string {
  const i = name.lastIndexOf(".");
  return i > 0 ? name.slice(0, i) : name;
}
function escapeMarkdownAlt(s: string): string {
  return s.replace(/([\[\]\(\)!\\])/g, "\\$1");
}
function fileNameFromURL(u: string): string {
  try {
    const p = new URL(u).pathname;
    const leaf = p.split("/").filter(Boolean).pop() ?? "image";
    return stripExt(decodeURIComponent(leaf));
  } catch {
    return "image";
  }
}

function isLikelyImageURL(s: string): boolean {
  // Heuristic only; server-side content-type is authoritative after fetch.
  return /^https?:\/\/.+\.(png|jpe?g|gif|webp|bmp|svg)(\?.*)?$/i.test(s);
}

async function reencodeImageToJPEG(file: File, quality: number): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("No 2D context");
    ctx.drawImage(bitmap, 0, 0);
    const blob = await canvas.convertToBlob({
      type: "image/jpeg",
      quality: Math.min(1, Math.max(0.1, quality)),
    });
    return blob;
  } catch {
    // Fallback to in-DOM canvas if OffscreenCanvas not available
    const c = document.createElement("canvas");
    c.width = bitmap.width;
    c.height = bitmap.height;
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("No 2D context");
    ctx.drawImage(bitmap, 0, 0);
    return await new Promise<Blob>((resolve) =>
      c.toBlob((b) => resolve(b ?? new Blob()), "image/jpeg", quality)
    );
  } finally {
    bitmap.close?.();
  }
}
