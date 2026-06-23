import { AnimatePresence, motion } from "framer-motion";
import { ChangeEvent, ClipboardEvent as ReactClipboardEvent, FormEvent, ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Extension } from "@tiptap/core";
import { Color } from "@tiptap/extension-color";
import Highlight from "@tiptap/extension-highlight";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import TextAlign from "@tiptap/extension-text-align";
import { TextStyle } from "@tiptap/extension-text-style";
import Underline from "@tiptap/extension-underline";
import StarterKit from "@tiptap/starter-kit";
import { EditorContent, useEditor } from "@tiptap/react";

type Theme = "light" | "dark";

type NoteImage = {
  id: string;
  name: string;
  type: string;
  assetId: string;
  dataUrl?: string;
};

type NoteFile = {
  id: string;
  name: string;
  type: string;
  size: number;
  assetId: string;
  dataUrl?: string;
};

type Note = {
  id: string;
  section: string;
  title: string;
  problemDescription: string;
  problemImages: NoteImage[];
  solutionText: string;
  solutionImages: NoteImage[];
  files: NoteFile[];
  createdAt: string;
  updatedAt: string;
};

type SearchResult = {
  note: Note;
  score: number;
};

type NoteDraft = {
  selectedSection: string;
  newSection: string;
  title: string;
  problemDescription: string;
  problemImages: NoteImage[];
  solutionText: string;
  solutionImages: NoteImage[];
  files: NoteFile[];
};

type ActiveGallery = {
  images: NoteImage[];
  index: number;
  label: string;
};

type Toast = {
  id: string;
  message: string;
  kind: "info" | "error" | "success";
};

const NOTES_STORAGE_KEY = "knowledge-notes-v2";
const THEME_STORAGE_KEY = "knowledge-theme-v1";
const SECTION_ORDER_STORAGE_KEY = "knowledge-sections-order-v1";
const NEW_SECTION_VALUE = "__new_section__";
const ASSETS_DB_NAME = "knowledge-assets-db";
const ASSETS_STORE_NAME = "assets";
const main_app = (import.meta.env.VITE_MAIN_APP as string | undefined) ?? "";
const APP_VIEW_HINT = (import.meta.env.VITE_VIEW_HINT as string | undefined) ?? "";
const LOGO_SRC = `${import.meta.env.BASE_URL}sosedi-logo.png`;

type AssetRecord = {
  id: string;
  name: string;
  type: string;
  size: number;
  dataUrl?: string;
  blob?: Blob;
};

type PlainExportPayload = {
  version: number;
  exportedAt: string;
  notes: Note[];
  sectionOrder: string[];
};

type EncryptedExportPayload = {
  version: number;
  encrypted: true;
  algorithm: "AES-GCM";
  kdf: "PBKDF2";
  iterations: number;
  salt: string;
  iv: string;
  data: string;
};

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function deriveEncryptionKey(passphrase: string, salt: ArrayBuffer, iterations: number): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey("raw", new TextEncoder().encode(passphrase), "PBKDF2", false, ["deriveKey"]);

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations,
      hash: "SHA-256",
    },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptPayload(payload: PlainExportPayload, passphrase: string): Promise<EncryptedExportPayload> {
  const iterations = 250000;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveEncryptionKey(passphrase, salt.buffer as ArrayBuffer, iterations);
  const encoded = new TextEncoder().encode(JSON.stringify(payload));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);

  return {
    version: 4,
    encrypted: true,
    algorithm: "AES-GCM",
    kdf: "PBKDF2",
    iterations,
    salt: arrayBufferToBase64(salt.buffer),
    iv: arrayBufferToBase64(iv.buffer),
    data: arrayBufferToBase64(encrypted),
  };
}

async function decryptPayload(payload: EncryptedExportPayload, passphrase: string): Promise<PlainExportPayload> {
  const salt = base64ToArrayBuffer(payload.salt);
  const iv = new Uint8Array(base64ToArrayBuffer(payload.iv));
  const encryptedData = base64ToArrayBuffer(payload.data);
  const key = await deriveEncryptionKey(passphrase, salt, payload.iterations);
  const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, encryptedData);
  const text = new TextDecoder().decode(decrypted);
  return JSON.parse(text) as PlainExportPayload;
}

function isEncryptedPayload(input: unknown): input is EncryptedExportPayload {
  return (
    typeof input === "object" &&
    input !== null &&
    (input as EncryptedExportPayload).encrypted === true &&
    typeof (input as EncryptedExportPayload).data === "string"
  );
}

function noteUpdatedAtMs(note: Note): number {
  const direct = Number(note.updatedAt);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const dateValue = Date.parse(note.updatedAt);
  return Number.isFinite(dateValue) ? dateValue : 0;
}

function openAssetsDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(ASSETS_DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(ASSETS_STORE_NAME)) {
        db.createObjectStore(ASSETS_STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("Не удалось открыть IndexedDB"));
  });
}

async function putAsset(asset: AssetRecord): Promise<void> {
  const db = await openAssetsDb();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(ASSETS_STORE_NAME, "readwrite");
    tx.objectStore(ASSETS_STORE_NAME).put(asset);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("Ошибка записи в IndexedDB"));
  });
  db.close();
}

async function putAssetBlob(id: string, file: File): Promise<void> {
  await putAsset({
    id,
    name: file.name,
    type: file.type || "application/octet-stream",
    size: file.size,
    blob: file,
  });
}

async function getAsset(assetId: string): Promise<AssetRecord | null> {
  const db = await openAssetsDb();
  const asset = await new Promise<AssetRecord | null>((resolve, reject) => {
    const tx = db.transaction(ASSETS_STORE_NAME, "readonly");
    const request = tx.objectStore(ASSETS_STORE_NAME).get(assetId);
    request.onsuccess = () => resolve((request.result as AssetRecord | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error("Ошибка чтения из IndexedDB"));
  });
  db.close();
  return asset;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Не удалось преобразовать blob"));
        return;
      }
      resolve(reader.result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Ошибка FileReader"));
    reader.readAsDataURL(blob);
  });
}

const FontFamily = Extension.create({
  name: "fontFamily",
  addGlobalAttributes() {
    return [
      {
        types: ["textStyle"],
        attributes: {
          fontFamily: {
            default: null,
            parseHTML: (element: HTMLElement) => element.style.fontFamily || null,
            renderHTML: (attributes: Record<string, string | null>) => {
              if (!attributes.fontFamily) return {};
              return { style: `font-family: ${attributes.fontFamily}` };
            },
          },
        },
      },
    ];
  },
  addCommands() {
    return {
      setFontFamily:
        (fontFamily: string) =>
        ({ chain }: { chain: () => any }) =>
          chain().setMark("textStyle", { fontFamily }).run(),
    };
  },
});

const FontSize = Extension.create({
  name: "fontSize",
  addGlobalAttributes() {
    return [
      {
        types: ["textStyle"],
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element: HTMLElement) => element.style.fontSize || null,
            renderHTML: (attributes: Record<string, string | null>) => {
              if (!attributes.fontSize) return {};
              return { style: `font-size: ${attributes.fontSize}` };
            },
          },
        },
      },
    ];
  },
  addCommands() {
    return {
      setFontSize:
        (fontSize: string) =>
        ({ chain }: { chain: () => any }) =>
          chain().setMark("textStyle", { fontSize }).run(),
    };
  },
});

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9\s]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function htmlToText(value: string): string {
  if (!value) return "";
  if (typeof window === "undefined") return value.replace(/<[^>]+>/g, " ");
  const parser = new DOMParser();
  const doc = parser.parseFromString(value, "text/html");
  return doc.body.textContent ?? "";
}

function htmlToClipboardText(value: string): string {
  if (!value) return "";

  const parser = new DOMParser();
  const doc = parser.parseFromString(value, "text/html");
  const lines: string[] = [];

  function inlineText(node: Node, skipLists = false): string {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? "";
    if (node.nodeType !== Node.ELEMENT_NODE) return "";

    const element = node as HTMLElement;
    const tag = element.tagName.toLowerCase();

    if (tag === "br") return "\n";
    if (skipLists && (tag === "ul" || tag === "ol")) return "";

    return Array.from(element.childNodes)
      .map((child) => inlineText(child, skipLists))
      .join("");
  }

  function walk(node: Node): void {
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const element = node as HTMLElement;
    const tag = element.tagName.toLowerCase();

    if (tag === "ol") {
      let index = 1;
      for (const child of Array.from(element.children)) {
        if (child.tagName.toLowerCase() !== "li") continue;
        const text = inlineText(child, true).trim();
        lines.push(text ? `${index}. ${text}` : `${index}.`);

        for (const nested of Array.from(child.children)) {
          const nestedTag = nested.tagName.toLowerCase();
          if (nestedTag === "ul" || nestedTag === "ol") walk(nested);
        }
        index += 1;
      }
      return;
    }

    if (tag === "ul") {
      for (const child of Array.from(element.children)) {
        if (child.tagName.toLowerCase() !== "li") continue;
        const text = inlineText(child, true).trim();
        lines.push(text ? `- ${text}` : "-");

        for (const nested of Array.from(child.children)) {
          const nestedTag = nested.tagName.toLowerCase();
          if (nestedTag === "ul" || nestedTag === "ol") walk(nested);
        }
      }
      return;
    }

    const isBlock = ["p", "div", "h1", "h2", "h3", "blockquote", "pre"].includes(tag);
    if (isBlock) {
      const text = inlineText(element).replace(/\u00a0/g, " ");
      lines.push(text.trim() ? text : "");
      return;
    }

    for (const child of Array.from(element.childNodes)) walk(child);
  }

  for (const child of Array.from(doc.body.childNodes)) walk(child);

  return lines.join("\n");
}

function tokenize(value: string): string[] {
  return normalizeText(value)
    .split(" ")
    .filter((token) => token.length > 1);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function levenshteinDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  const rows = a.length + 1;
  const cols = b.length + 1;
  const matrix: number[][] = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let i = 0; i < rows; i += 1) matrix[i][0] = i;
  for (let j = 0; j < cols; j += 1) matrix[0][j] = j;

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(matrix[i - 1][j] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j - 1] + cost);
    }
  }

  return matrix[rows - 1][cols - 1];
}

function bigramSimilarity(a: string, b: string): number {
  if (!a.length || !b.length) return 0;
  if (a === b) return 1;

  const bigrams = (input: string): string[] => {
    if (input.length < 2) return [input];
    const values: string[] = [];
    for (let i = 0; i < input.length - 1; i += 1) values.push(input.slice(i, i + 2));
    return values;
  };

  const aBigrams = bigrams(a);
  const bBigrams = bigrams(b);
  const counts = new Map<string, number>();
  let intersections = 0;

  for (const token of aBigrams) counts.set(token, (counts.get(token) ?? 0) + 1);
  for (const token of bBigrams) {
    const count = counts.get(token) ?? 0;
    if (count > 0) {
      intersections += 1;
      counts.set(token, count - 1);
    }
  }

  return (2 * intersections) / (aBigrams.length + bBigrams.length);
}

function bestTokenSimilarity(queryToken: string, targetTokens: string[]): number {
  if (!targetTokens.length) return 0;

  let best = 0;
  for (const token of targetTokens) {
    if (token.includes(queryToken) || queryToken.includes(token)) {
      best = Math.max(best, 1);
      continue;
    }

    const distance = levenshteinDistance(queryToken, token);
    const longest = Math.max(queryToken.length, token.length);
    const similarity = Math.max(0, 1 - distance / longest);
    best = Math.max(best, similarity);
  }

  return best;
}

function scoreText(query: string, target: string): number {
  const q = normalizeText(query);
  const t = normalizeText(target);
  if (!q || !t) return 0;
  if (t.includes(q)) return 1;

  const queryTokens = tokenize(q);
  const targetTokens = tokenize(t);
  if (!queryTokens.length || !targetTokens.length) return bigramSimilarity(q, t);

  const tokenAverage =
    queryTokens.reduce((sum, token) => sum + bestTokenSimilarity(token, targetTokens), 0) / queryTokens.length;

  return tokenAverage * 0.75 + bigramSimilarity(q, t) * 0.25;
}

function noteScore(note: Note, query: string): number {
  const title = scoreText(query, note.title);
  const section = scoreText(query, note.section);
  const problem = scoreText(query, htmlToText(note.problemDescription));
  const solution = scoreText(query, htmlToText(note.solutionText));
  const files = scoreText(query, note.files.map((file) => file.name).join(" "));
  return Math.max(title, section * 0.8, problem, solution * 0.9, files * 0.75);
}

function highlightText(text: string, query: string): ReactNode {
  const tokens = tokenize(query).filter((token) => token.length > 1);
  if (!tokens.length) return text;

  const uniqueTokens = Array.from(new Set(tokens));
  const regex = new RegExp(`(${uniqueTokens.map((token) => escapeRegExp(token)).join("|")})`, "gi");
  const chunks = text.split(regex);
  if (chunks.length === 1) return text;

  return (
    <>
      {chunks.map((chunk, index) => {
        const isMatch = uniqueTokens.some((token) => token.toLowerCase() === normalizeText(chunk));
        if (!isMatch) return <span key={`${chunk}-${index}`}>{chunk}</span>;

        return (
          <mark key={`${chunk}-${index}`} className="rounded bg-yellow-200 px-1 text-slate-900 dark:bg-yellow-300">
            {chunk}
          </mark>
        );
      })}
    </>
  );
}

function highlightHtmlContent(html: string, query: string): string {
  const tokens = tokenize(query).filter((token) => token.length > 1);
  if (!tokens.length || !html) return html;

  const uniqueTokens = Array.from(new Set(tokens));
  const regex = new RegExp(`(${uniqueTokens.map((token) => escapeRegExp(token)).join("|")})`, "gi");

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];

  let current = walker.nextNode();
  while (current) {
    textNodes.push(current as Text);
    current = walker.nextNode();
  }

  for (const textNode of textNodes) {
    const text = textNode.nodeValue ?? "";
    if (!text.trim()) continue;
    if (!regex.test(text)) {
      regex.lastIndex = 0;
      continue;
    }
    regex.lastIndex = 0;

    const parts = text.split(regex);
    const fragment = doc.createDocumentFragment();

    for (const part of parts) {
      if (!part) continue;
      const normalizedPart = normalizeText(part);
      const isMatch = uniqueTokens.some((token) => token === normalizedPart);

      if (isMatch) {
        const mark = doc.createElement("mark");
        mark.className = "rounded bg-yellow-200 px-1 text-slate-900";
        mark.textContent = part;
        fragment.appendChild(mark);
      } else {
        fragment.appendChild(doc.createTextNode(part));
      }
    }

    textNode.replaceWith(fragment);
  }

  return doc.body.innerHTML;
}

function toDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string") {
        reject(new Error("Не удалось прочитать файл"));
        return;
      }
      resolve(reader.result);
    };
    reader.onerror = () => reject(reader.error ?? new Error("Ошибка чтения файла"));
    reader.readAsDataURL(file);
  });
}

async function toClipboardCompatibleImageBlob(sourceBlob: Blob): Promise<Blob> {
  if (sourceBlob.type === "image/png") return sourceBlob;

  const objectUrl = URL.createObjectURL(sourceBlob);

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Не удалось декодировать изображение"));
      img.src = objectUrl;
    });

    const canvas = document.createElement("canvas");
    canvas.width = image.naturalWidth || image.width;
    canvas.height = image.naturalHeight || image.height;

    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas недоступен");

    context.drawImage(image, 0, 0);

    const pngBlob = await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (!blob) {
          reject(new Error("Не удалось конвертировать изображение"));
          return;
        }
        resolve(blob);
      }, "image/png");
    });

    return pngBlob;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [meta, base64] = dataUrl.split(",");
  const mimeMatch = meta.match(/data:(.*?);base64/);
  const mime = mimeMatch?.[1] || "application/octet-stream";
  const binary = atob(base64 || "");
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} Б`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} КБ`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} МБ`;
}

function sanitizeImages(raw: unknown): NoteImage[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((image) => !!image && typeof image === "object")
    .map((image) => {
      const parsed = image as Partial<NoteImage>;
      const fallbackId = typeof parsed.id === "string" ? parsed.id : crypto.randomUUID();
      return {
        id: fallbackId,
        name: typeof parsed.name === "string" ? parsed.name : "image",
        type: typeof parsed.type === "string" ? parsed.type : "image/png",
        assetId: typeof parsed.assetId === "string" ? parsed.assetId : fallbackId,
        dataUrl: typeof parsed.dataUrl === "string" ? parsed.dataUrl : undefined,
      };
    });
}

function sanitizeFiles(raw: unknown): NoteFile[] {
  if (!Array.isArray(raw)) return [];

  return raw
    .filter((file) => !!file && typeof file === "object")
    .map((file) => {
      const parsed = file as Partial<NoteFile>;
      const fallbackId = typeof parsed.id === "string" ? parsed.id : crypto.randomUUID();
      return {
        id: fallbackId,
        name: typeof parsed.name === "string" ? parsed.name : "file",
        type: typeof parsed.type === "string" ? parsed.type : "application/octet-stream",
        size: typeof parsed.size === "number" ? parsed.size : 0,
        assetId: typeof parsed.assetId === "string" ? parsed.assetId : fallbackId,
        dataUrl: typeof parsed.dataUrl === "string" ? parsed.dataUrl : undefined,
      };
    });
}

async function persistInlineAssets(notes: Note[]): Promise<Note[]> {
  return Promise.all(
    notes.map(async (note) => {
      const problemImages = await Promise.all(
        note.problemImages.map(async (image) => {
          if (image.dataUrl) {
            await putAsset({
              id: image.assetId,
              name: image.name,
              type: image.type,
              size: image.dataUrl.length,
              dataUrl: image.dataUrl,
            });
          }
          return { ...image, dataUrl: undefined };
        })
      );

      const solutionImages = await Promise.all(
        note.solutionImages.map(async (image) => {
          if (image.dataUrl) {
            await putAsset({
              id: image.assetId,
              name: image.name,
              type: image.type,
              size: image.dataUrl.length,
              dataUrl: image.dataUrl,
            });
          }
          return { ...image, dataUrl: undefined };
        })
      );

      const files = await Promise.all(
        note.files.map(async (file) => {
          if (file.dataUrl) {
            await putAsset({
              id: file.assetId,
              name: file.name,
              type: file.type,
              size: file.size,
              dataUrl: file.dataUrl,
            });
          }
          return { ...file, dataUrl: undefined };
        })
      );

      return { ...note, problemImages, solutionImages, files };
    })
  );
}

async function hydrateNotesAssets(notes: Note[]): Promise<Note[]> {
  return Promise.all(
    notes.map(async (note) => {
      const problemImages = await Promise.all(
        note.problemImages.map(async (image) => {
          if (image.dataUrl) return image;
          const asset = await getAsset(image.assetId);
          return { ...image, dataUrl: asset?.dataUrl };
        })
      );

      const solutionImages = await Promise.all(
        note.solutionImages.map(async (image) => {
          if (image.dataUrl) return image;
          const asset = await getAsset(image.assetId);
          return { ...image, dataUrl: asset?.dataUrl };
        })
      );

      const files = note.files.map((file) => ({ ...file, dataUrl: undefined }));

      return { ...note, problemImages, solutionImages, files };
    })
  );
}

async function resolveFileDataUrl(file: NoteFile): Promise<string | undefined> {
  if (file.dataUrl) return file.dataUrl;
  const asset = await getAsset(file.assetId);
  if (!asset) return undefined;
  if (asset.dataUrl) return asset.dataUrl;
  if (asset.blob) return blobToDataUrl(asset.blob);
  return undefined;
}

function serializeNotesForLocalStorage(notes: Note[]): Note[] {
  return notes.map((note) => ({
    ...note,
    problemImages: note.problemImages.map((image) => ({ ...image, dataUrl: undefined })),
    solutionImages: note.solutionImages.map((image) => ({ ...image, dataUrl: undefined })),
    files: note.files.map((file) => ({ ...file, dataUrl: undefined })),
  }));
}

type RichTextEditorProps = {
  value: string;
  onChange: (value: string) => void;
  isDark: boolean;
  placeholder: string;
  minHeight?: string;
};

function RichTextEditor({ value, onChange, isDark, placeholder, minHeight = "140px" }: RichTextEditorProps) {
  const [, forceToolbarUpdate] = useState(0);

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      Underline,
      TextStyle,
      FontFamily,
      FontSize,
      Color,
      Highlight,
      Link.configure({
        openOnClick: true,
        autolink: true,
        defaultProtocol: "https",
      }),
      TextAlign.configure({ types: ["heading", "paragraph"] }),
      Placeholder.configure({ placeholder }),
    ],
    content: value || "",
    editorProps: {
      attributes: {
        class: "tiptap-editor min-h-[120px] px-3 py-2 text-sm outline-none",
      },
    },
    onUpdate: ({ editor: instance }) => {
      onChange(instance.getHTML());
    },
  });

  useEffect(() => {
    if (!editor) return;
    const current = editor.getHTML();
    if (current !== value) {
      editor.commands.setContent(value || "", { emitUpdate: false });
    }
  }, [editor, value]);

  useEffect(() => {
    if (!editor) return;

    const refresh = () => forceToolbarUpdate((value) => value + 1);

    editor.on("selectionUpdate", refresh);
    editor.on("transaction", refresh);
    editor.on("focus", refresh);
    editor.on("blur", refresh);

    return () => {
      editor.off("selectionUpdate", refresh);
      editor.off("transaction", refresh);
      editor.off("focus", refresh);
      editor.off("blur", refresh);
    };
  }, [editor]);

  const toolbarBaseClass = `rounded px-2 py-1 text-xs transition border ${
    isDark ? "border-[#7B4A24]" : "border-[#FFD0A7]"
  }`;
  const toolbarDefaultClass = isDark
    ? "bg-[#3D2B1E] text-[#FFF7EE] hover:bg-[#5A3D2A]"
    : "bg-[#FFE9D4] text-[#A3530A] hover:bg-[#FFD9B8]";
  const toolbarActiveClass = "bg-[#FF7A01] text-white border-[#FF7A01]";

  function toolbarClass(active: boolean): string {
    return `${toolbarBaseClass} ${active ? toolbarActiveClass : toolbarDefaultClass}`;
  }

  if (!editor) return null;

  return (
    <div
      className={`overflow-hidden rounded-xl border ${
        isDark ? "border-[#9A5A26] bg-[#2B2B2B]" : "border-[#FFBF87] bg-[#FFFAF5]"
      }`}
    >
      <div className={`flex flex-wrap items-center gap-1 border-b p-2 ${isDark ? "border-[#5A3416]" : "border-[#FFD9B8]"}`}>
        <select
          className={`${toolbarClass(Boolean(editor.getAttributes("textStyle").fontFamily))} pr-1`}
          value={editor.getAttributes("textStyle").fontFamily || ""}
          onChange={(event) => {
            if (!event.target.value) {
              editor.chain().focus().setMark("textStyle", { fontFamily: null }).run();
              return;
            }
            editor.chain().focus().setFontFamily(event.target.value).run();
          }}
        >
          <option value="">Шрифт</option>
          <option value="Arial">Arial</option>
          <option value="Tahoma">Tahoma</option>
          <option value="Verdana">Verdana</option>
          <option value="Times New Roman">Times</option>
          <option value="Courier New">Courier</option>
        </select>
        <select
          className={`${toolbarClass(Boolean(editor.getAttributes("textStyle").fontSize))} pr-1`}
          value={editor.getAttributes("textStyle").fontSize || ""}
          onChange={(event) => {
            if (!event.target.value) {
              editor.chain().focus().setMark("textStyle", { fontSize: null }).run();
              return;
            }
            editor.chain().focus().setFontSize(event.target.value).run();
          }}
        >
          <option value="">Размер</option>
          <option value="12px">12</option>
          <option value="14px">14</option>
          <option value="16px">16</option>
          <option value="18px">18</option>
          <option value="22px">22</option>
          <option value="28px">28</option>
        </select>
        <button type="button" className={toolbarClass(editor.isActive("bold"))} onClick={() => editor.chain().focus().toggleBold().run()}>
          Ж
        </button>
        <button type="button" className={toolbarClass(editor.isActive("italic"))} onClick={() => editor.chain().focus().toggleItalic().run()}>
          К
        </button>
        <button type="button" className={toolbarClass(editor.isActive("underline"))} onClick={() => editor.chain().focus().toggleUnderline().run()}>
          Ч
        </button>
        <button type="button" className={toolbarClass(editor.isActive("strike"))} onClick={() => editor.chain().focus().toggleStrike().run()}>
          S
        </button>
        <button type="button" className={toolbarClass(editor.isActive("bulletList"))} onClick={() => editor.chain().focus().toggleBulletList().run()}>
          Список
        </button>
        <button type="button" className={toolbarClass(editor.isActive("orderedList"))} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
          1.
        </button>
        <button type="button" className={toolbarClass(editor.isActive("blockquote"))} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
          ""
        </button>
        <button type="button" className={toolbarClass(editor.isActive("codeBlock"))} onClick={() => editor.chain().focus().toggleCodeBlock().run()}>
          {'</>'}
        </button>
        <button type="button" className={toolbarClass(editor.isActive({ textAlign: "left" }))} onClick={() => editor.chain().focus().setTextAlign("left").run()}>
          L
        </button>
        <button type="button" className={toolbarClass(editor.isActive({ textAlign: "center" }))} onClick={() => editor.chain().focus().setTextAlign("center").run()}>
          C
        </button>
        <button type="button" className={toolbarClass(editor.isActive({ textAlign: "right" }))} onClick={() => editor.chain().focus().setTextAlign("right").run()}>
          R
        </button>
        <button type="button" className={toolbarClass(editor.isActive("heading", { level: 1 }))} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>
          H1
        </button>
        <button type="button" className={toolbarClass(editor.isActive("heading", { level: 2 }))} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
          H2
        </button>
        <button type="button" className={toolbarClass(editor.isActive("heading", { level: 3 }))} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>
          H3
        </button>
        <label className={`${toolbarClass(Boolean(editor.getAttributes("textStyle").color))} cursor-pointer`}>
          Цвет
          <input
            type="color"
            className="ml-1 h-4 w-4 cursor-pointer align-middle"
            value={editor.getAttributes("textStyle").color || "#000000"}
            onChange={(event) => editor.chain().focus().setColor(event.target.value).run()}
          />
        </label>
        <button
          type="button"
          className={toolbarClass(editor.isActive("link"))}
          onClick={() => {
            const url = window.prompt("Введите ссылку");
            if (!url) return;
            editor.chain().focus().setLink({ href: url }).run();
          }}
        >
          Ссылка
        </button>
        <button type="button" className={toolbarClass(false)} onClick={() => editor.chain().focus().unsetAllMarks().clearNodes().run()}>
          Очистить
        </button>
      </div>
      <EditorContent editor={editor} style={{ minHeight }} className={`${isDark ? "text-[#FFF7EE]" : "text-[#2A2A2A]"}`} />
    </div>
  );
}

function sanitizeNote(raw: unknown): Note | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, unknown>;

  const createdAt = typeof item.createdAt === "string" ? item.createdAt : new Date().toISOString();
  const updatedAt = typeof item.updatedAt === "string" ? item.updatedAt : createdAt;
  const solutionText =
    typeof item.solutionText === "string" ? item.solutionText : typeof item.description === "string" ? item.description : "";

  return {
    id: typeof item.id === "string" ? item.id : crypto.randomUUID(),
    section: typeof item.section === "string" ? item.section.trim() || "Без раздела" : "Без раздела",
    title: typeof item.title === "string" ? item.title : "Без заголовка",
    problemDescription: typeof item.problemDescription === "string" ? item.problemDescription : "",
    problemImages: sanitizeImages(item.problemImages),
    solutionText,
    solutionImages: sanitizeImages(item.solutionImages ?? item.images),
    files: sanitizeFiles(item.files),
    createdAt,
    updatedAt,
  };
}

function createEmptyDraft(section = NEW_SECTION_VALUE): NoteDraft {
  return {
    selectedSection: section,
    newSection: "",
    title: "",
    problemDescription: "",
    problemImages: [],
    solutionText: "",
    solutionImages: [],
    files: [],
  };
}

export default function App() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    if (saved === "dark" || saved === "light") return saved;
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  const [searchQuery, setSearchQuery] = useState("");
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const [sectionOrder, setSectionOrder] = useState<string[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [isStorageReady, setIsStorageReady] = useState(false);

  const [isEditorOpen, setIsEditorOpen] = useState(false);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const [draft, setDraft] = useState<NoteDraft>(createEmptyDraft());

  const [activeGallery, setActiveGallery] = useState<ActiveGallery | null>(null);
  const [copiedTextNoteId, setCopiedTextNoteId] = useState<string | null>(null);
  const [copiedImageId, setCopiedImageId] = useState<string | null>(null);
  const [themeCurtain, setThemeCurtain] = useState<{ visible: boolean; color: string; opacity: number }>({
    visible: false,
    color: "#FFF9F2",
    opacity: 1,
  });
  const [exportProgress, setExportProgress] = useState<{ active: boolean; value: number; label: string }>({
    active: false,
    value: 0,
    label: "",
  });

  const importInputRef = useRef<HTMLInputElement | null>(null);
  const mergeInputRef = useRef<HTMLInputElement | null>(null);

  function pushToast(message: string, kind: Toast["kind"] = "info", duration = 3200): void {
    const id = crypto.randomUUID();
    setToasts((current) => [...current, { id, message, kind }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, duration);
  }

  function removeToast(id: string): void {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }

  function handleLogoClick(): void {
    setExpandedSections(new Set());
    setSearchQuery("");
    window.scrollTo({ top: 0, behavior: "smooth" });
  }


  useEffect(() => {
    void (async () => {
      try {
        const v2 = localStorage.getItem(NOTES_STORAGE_KEY);
        const v1 = localStorage.getItem("knowledge-notes-v1");
        const raw = v2 ?? v1;

        if (raw) {
          const parsed = JSON.parse(raw) as unknown;
          if (Array.isArray(parsed)) {
            const sanitized = parsed.map((item) => sanitizeNote(item)).filter((item): item is Note => item !== null);
            const migrated = await persistInlineAssets(sanitized);
            const hydrated = await hydrateNotesAssets(migrated);
            setNotes(hydrated);
          }
        }

        const storedOrderRaw = localStorage.getItem(SECTION_ORDER_STORAGE_KEY);
        if (storedOrderRaw) {
          const parsedOrder = JSON.parse(storedOrderRaw) as unknown;
          if (Array.isArray(parsedOrder)) {
            setSectionOrder(parsedOrder.filter((item): item is string => typeof item === "string"));
          }
        }
      } catch {
        pushToast("Не удалось загрузить сохраненную базу.", "error");
      } finally {
        setIsStorageReady(true);
      }
    })();
  }, []);

  useEffect(() => {
    if (!isStorageReady) return;
    try {
      const compact = serializeNotesForLocalStorage(notes);
      localStorage.setItem(NOTES_STORAGE_KEY, JSON.stringify(compact));
    } catch {
      pushToast("Не удалось сохранить заметки локально.", "error");
    }
  }, [isStorageReady, notes]);

  useEffect(() => {
    if (!isStorageReady) return;
    try {
      localStorage.setItem(SECTION_ORDER_STORAGE_KEY, JSON.stringify(sectionOrder));
    } catch {
      pushToast("Не удалось сохранить порядок разделов локально.", "error");
    }
  }, [isStorageReady, sectionOrder]);

  useLayoutEffect(() => {
    localStorage.setItem(THEME_STORAGE_KEY, theme);
    document.documentElement.classList.toggle("dark", theme === "dark");
  }, [theme]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (activeGallery) {
          setActiveGallery(null);
          return;
        }
        if (isEditorOpen) setIsEditorOpen(false);
        return;
      }

      if (!activeGallery) return;

      if (event.key === "ArrowRight") {
        event.preventDefault();
        setActiveGallery((current) => {
          if (!current || current.images.length < 2) return current;
          return { ...current, index: (current.index + 1) % current.images.length };
        });
      }

      if (event.key === "ArrowLeft") {
        event.preventDefault();
        setActiveGallery((current) => {
          if (!current || current.images.length < 2) return current;
          return { ...current, index: (current.index - 1 + current.images.length) % current.images.length };
        });
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeGallery, isEditorOpen]);

  const availableSections = useMemo(() => {
    return Array.from(new Set(notes.map((note) => note.section.trim()).filter(Boolean))).sort((a, b) =>
      a.localeCompare(b, "ru")
    );
  }, [notes]);

  useEffect(() => {
    setSectionOrder((current) => {
      if (availableSections.length === 0) return current;

      const filtered = current.filter((section) => availableSections.includes(section));
      const missing = availableSections.filter((section) => !filtered.includes(section));
      if (filtered.length === current.length && missing.length === 0) return current;
      return [...filtered, ...missing];
    });
  }, [availableSections]);

  const sections = useMemo(() => {
    const ordered = sectionOrder.filter((section) => availableSections.includes(section));
    const missing = availableSections.filter((section) => !ordered.includes(section));
    return [...ordered, ...missing];
  }, [sectionOrder, availableSections]);

  const searchResults = useMemo<SearchResult[]>(() => {
    if (!searchQuery.trim()) {
      return notes
        .map((note) => ({ note, score: 1 }))
        .sort((a, b) => new Date(b.note.updatedAt).getTime() - new Date(a.note.updatedAt).getTime());
    }

    return notes
      .map((note) => ({ note, score: noteScore(note, searchQuery) }))
      .filter((entry) => entry.score >= 0.42)
      .sort((a, b) => b.score - a.score);
  }, [notes, searchQuery]);

const groupedResults = useMemo(() => {
  const grouped = new Map<string, SearchResult[]>();
  for (const result of searchResults) {
    const list = grouped.get(result.note.section) ?? [];
    list.push(result);
    grouped.set(result.note.section, list);
  }

  const entries = Array.from(grouped.entries());
  if (searchQuery.trim()) {
    return entries.sort((a, b) => {
      const bestA = Math.max(...a[1].map((item) => item.score));
      const bestB = Math.max(...b[1].map((item) => item.score));
      if (bestA !== bestB) return bestB - bestA;

      // If scores are equal, fallback to manual section order.
      const aIndex = sections.indexOf(a[0]);
      const bIndex = sections.indexOf(b[0]);
      const safeA = aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex;
      const safeB = bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex;
      return safeA - safeB;
    });
  }

  return entries.sort((a, b) => {
    const aIndex = sections.indexOf(a[0]);
    const bIndex = sections.indexOf(b[0]);
    const safeA = aIndex === -1 ? Number.MAX_SAFE_INTEGER : aIndex;
    const safeB = bIndex === -1 ? Number.MAX_SAFE_INTEGER : bIndex;
    return safeA - safeB;
  });
}, [searchQuery, searchResults, sections]);

  const autoExpandedSections = useMemo(() => {
    if (!searchQuery.trim()) return new Set<string>();
    return new Set(groupedResults.map(([section]) => section));
  }, [groupedResults, searchQuery]);

  const isDark = theme === "dark";

  function toggleThemeSmooth(): void {
    if (themeCurtain.visible) return;

    const nextTheme: Theme = theme === "dark" ? "light" : "dark";
    document.body.classList.add("theme-switching");

    // Force curtain to be painted before mutating the whole theme tree.
    flushSync(() => {
      setThemeCurtain({
        visible: true,
        color: theme === "dark" ? "#1B1B1B" : "#FFF9F2",
        opacity: 1,
      });
    });

    window.requestAnimationFrame(() => {
      setTheme(nextTheme);
      window.requestAnimationFrame(() => {
        setThemeCurtain((current) => ({ ...current, opacity: 0 }));
        window.setTimeout(() => {
          setThemeCurtain((current) => ({ ...current, visible: false, opacity: 1 }));
          document.body.classList.remove("theme-switching");
        }, 260);
      });
    });
  }

  const activeImage = activeGallery ? activeGallery.images[activeGallery.index] : null;

  function openImageViewer(images: NoteImage[], startIndex: number, label: string): void {
    if (!images.length) return;
    const safeIndex = Math.max(0, Math.min(startIndex, images.length - 1));
    setActiveGallery({ images, index: safeIndex, label });
  }

  function shiftImage(step: number): void {
    setActiveGallery((current) => {
      if (!current || current.images.length < 2) return current;
      return {
        ...current,
        index: (current.index + step + current.images.length) % current.images.length,
      };
    });
  }

  function openCreateModal(): void {
    setEditingNoteId(null);
    setDraft(createEmptyDraft(sections[0] ?? NEW_SECTION_VALUE));
    setIsEditorOpen(true);
  }

  function openEditModal(note: Note): void {
    setEditingNoteId(note.id);
    setDraft({
      selectedSection: note.section,
      newSection: "",
      title: note.title,
      problemDescription: note.problemDescription,
      problemImages: [...note.problemImages],
      solutionText: note.solutionText,
      solutionImages: [...note.solutionImages],
      files: [...note.files],
    });
    setIsEditorOpen(true);
  }

  function toggleSection(section: string): void {
    if (searchQuery.trim()) return;
    setExpandedSections((previous) => {
      const updated = new Set(previous);
      if (updated.has(section)) updated.delete(section);
      else updated.add(section);
      return updated;
    });
  }

  function moveSection(section: string, direction: -1 | 1): void {
    setSectionOrder((current) => {
      const index = current.indexOf(section);
      if (index === -1) return current;
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= current.length) return current;

      const next = [...current];
      const [moved] = next.splice(index, 1);
      next.splice(nextIndex, 0, moved);
      return next;
    });
  }

  async function handleAddImages(event: ChangeEvent<HTMLInputElement>, field: "problemImages" | "solutionImages"): Promise<void> {
    const files = Array.from(event.target.files ?? []).filter((file) => file.type.startsWith("image/"));
    if (!files.length) return;

    try {
      const prepared = await Promise.all(
        files.map(async (file) => {
          const assetId = crypto.randomUUID();
          const dataUrl = await toDataUrl(file);
          await putAsset({
            id: assetId,
            name: file.name,
            type: file.type,
            size: file.size,
            dataUrl,
          });

          return {
            id: crypto.randomUUID(),
            name: file.name,
            type: file.type,
            assetId,
            dataUrl,
          };
        })
      );

      setDraft((previous) => ({ ...previous, [field]: [...previous[field], ...prepared] }));
      event.target.value = "";
    } catch {
      pushToast("Ошибка при загрузке изображений.", "error");
    }
  }

  async function appendImagesFromFiles(
  files: File[],
  field: "problemImages" | "solutionImages"
): Promise<void> {
  const images = files.filter((file) => file.type.startsWith("image/"));
  if (!images.length) return;

  try {
    const prepared = await Promise.all(
      images.map(async (file) => {
        const assetId = crypto.randomUUID();
        const dataUrl = await toDataUrl(file);

        await putAsset({
          id: assetId,
          name: file.name,
          type: file.type,
          size: file.size,
          dataUrl,
        });

        return {
          id: crypto.randomUUID(),
          name: file.name,
          type: file.type,
          assetId,
          dataUrl,
        };
      })
    );

    setDraft((previous) => ({ ...previous, [field]: [...previous[field], ...prepared] }));
  } catch {
    pushToast("Ошибка при загрузке изображений.", "error");
  }
}

async function handlePasteImages(
  event: ReactClipboardEvent<HTMLDivElement>,
  field: "problemImages" | "solutionImages"
): Promise<void> {
  const files = Array.from(event.clipboardData.items)
    .filter((item) => item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);

  if (!files.length) return;

  event.preventDefault();
  await appendImagesFromFiles(files, field);
  pushToast(
    field === "problemImages"
      ? "Изображение вставлено в Фото проблемы"
      : "Изображение вставлено в Фото решения",
    "success",
    1700
  );
}
  
  function removeDraftImage(field: "problemImages" | "solutionImages", imageId: string): void {
    setDraft((previous) => ({ ...previous, [field]: previous[field].filter((image) => image.id !== imageId) }));
  }

  async function handleAddFiles(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const files = Array.from(event.target.files ?? []);
    if (!files.length) return;

    try {
      const prepared = await Promise.all(
        files.map(async (file) => {
          const assetId = crypto.randomUUID();
          await putAssetBlob(assetId, file);

          return {
            id: crypto.randomUUID(),
            name: file.name,
            type: file.type || "application/octet-stream",
            size: file.size,
            assetId,
            dataUrl: undefined,
          };
        })
      );

      setDraft((previous) => ({ ...previous, files: [...previous.files, ...prepared] }));
      event.target.value = "";
    } catch {
      pushToast("Ошибка при загрузке файлов.", "error");
    }
  }

  function removeDraftFile(fileId: string): void {
    setDraft((previous) => ({ ...previous, files: previous.files.filter((file) => file.id !== fileId) }));
  }

  async function downloadFile(file: NoteFile): Promise<void> {
    const stored = await getAsset(file.assetId);
    const anchor = document.createElement("a");

    if (stored?.blob) {
      const url = URL.createObjectURL(stored.blob);
      anchor.href = url;
      anchor.download = file.name;
      anchor.click();
      URL.revokeObjectURL(url);
      return;
    }

    const dataUrl = file.dataUrl ?? stored?.dataUrl;
    if (!dataUrl) {
      pushToast("Файл не найден в локальном хранилище.", "error");
      return;
    }

    anchor.href = dataUrl;
    anchor.download = file.name;
    anchor.click();
  }

  function handleSaveNote(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const resolvedSection =
      draft.selectedSection === NEW_SECTION_VALUE ? draft.newSection.trim() : draft.selectedSection.trim();

    const cleanSolution = htmlToText(draft.solutionText).trim();
    if (!resolvedSection || !draft.title.trim() || !cleanSolution) {
      pushToast("Заполните раздел, заголовок и решение.", "error");
      return;
    }

    const now = new Date().toISOString();
    if (editingNoteId) {
      setNotes((previous) =>
        previous.map((note) =>
          note.id === editingNoteId
            ? {
                ...note,
                section: resolvedSection,
                title: draft.title.trim(),
                problemDescription: draft.problemDescription,
                problemImages: draft.problemImages,
                solutionText: draft.solutionText,
                solutionImages: draft.solutionImages,
                files: draft.files,
                updatedAt: now,
              }
            : note
        )
      );
      pushToast("Заметка обновлена.", "success");
    } else {
      const created: Note = {
        id: crypto.randomUUID(),
        section: resolvedSection,
        title: draft.title.trim(),
        problemDescription: draft.problemDescription,
        problemImages: draft.problemImages,
        solutionText: draft.solutionText,
        solutionImages: draft.solutionImages,
        files: draft.files,
        createdAt: now,
        updatedAt: now,
      };

      setNotes((previous) => [created, ...previous]);
      pushToast("Заметка сохранена.", "success");
    }

    setExpandedSections((previous) => {
      const updated = new Set(previous);
      updated.add(resolvedSection);
      return updated;
    });

    setIsEditorOpen(false);
    setEditingNoteId(null);
    setDraft(createEmptyDraft(sections[0] ?? NEW_SECTION_VALUE));
  }

  function handleDeleteNote(note: Note): void {
    const approved = window.confirm(`Удалить заметку "${note.title}"?`);
    if (!approved) return;
    setNotes((previous) => previous.filter((item) => item.id !== note.id));
    pushToast("Заметка удалена.", "success");
  }

  async function copyNoteText(note: Note): Promise<void> {
    try {
      await navigator.clipboard.writeText(htmlToClipboardText(note.solutionText));
      setCopiedTextNoteId(note.id);
      window.setTimeout(() => setCopiedTextNoteId((current) => (current === note.id ? null : current)), 1300);
    } catch {
      pushToast("Не удалось скопировать текст.", "error");
    }
  }

  async function copyImageToClipboard(image: NoteImage): Promise<void> {
    try {
      const dataUrl = image.dataUrl ?? (await getAsset(image.assetId))?.dataUrl;
      if (!dataUrl) throw new Error("Изображение не найдено");

      const blob = dataUrlToBlob(dataUrl);

      if (!("ClipboardItem" in window) || !navigator.clipboard?.write) {
        throw new Error("Clipboard API недоступен");
      }

      // Для Windows/Chromium надежнее класть в буфер PNG: JPG часто не принимается Clipboard API.
      const pngBlob = await toClipboardCompatibleImageBlob(blob);

      try {
        await navigator.clipboard.write([new ClipboardItem({ "image/png": pngBlob })]);
      } catch {
        // Fallback для браузеров, которые принимают исходный MIME лучше чем PNG.
        await navigator.clipboard.write([new ClipboardItem({ [blob.type || image.type || "image/jpeg"]: blob })]);
      }

      setCopiedImageId(image.id);
      window.setTimeout(() => setCopiedImageId((current) => (current === image.id ? null : current)), 1300);
    } catch {
      pushToast("Не удалось скопировать картинку (проверьте HTTPS/браузер).", "error");
    }
  }

  async function parseImportedText(text: string): Promise<{ notes: Note[]; sectionOrder: string[] | null }> {
    let parsed = JSON.parse(text) as unknown;

    if (isEncryptedPayload(parsed)) {
      if (!main_app) {
        throw new Error("Не удалось открыть защищенный файл");
      }
      parsed = await decryptPayload(parsed, main_app);
    }

    const imported = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { notes?: unknown }).notes)
        ? (parsed as { notes: unknown[] }).notes
        : null;

    if (!imported) throw new Error("Некорректный формат");

    const cleaned = imported.map((note) => sanitizeNote(note)).filter((note): note is Note => note !== null);
    const migrated = await persistInlineAssets(cleaned);
    const hydrated = await hydrateNotesAssets(migrated);
    const importedOrder =
      typeof parsed === "object" && parsed !== null && Array.isArray((parsed as { sectionOrder?: unknown }).sectionOrder)
        ? (parsed as { sectionOrder: unknown[] }).sectionOrder.filter((item): item is string => typeof item === "string")
        : null;

    return { notes: hydrated, sectionOrder: importedOrder };
  }

  function mergeByUuid(existing: Note[], incoming: Note[]): Note[] {
    const byId = new Map(existing.map((note) => [note.id, note]));

    for (const incomingNote of incoming) {
      const current = byId.get(incomingNote.id);
      if (!current) {
        byId.set(incomingNote.id, incomingNote);
        continue;
      }

      const incomingTs = noteUpdatedAtMs(incomingNote);
      const currentTs = noteUpdatedAtMs(current);
      if (incomingTs >= currentTs) {
        byId.set(incomingNote.id, incomingNote);
      }
    }

    return Array.from(byId.values()).sort((a, b) => noteUpdatedAtMs(b) - noteUpdatedAtMs(a));
  }

  async function exportNotes(): Promise<void> {
    if (!main_app) {
      pushToast("Защищенный экспорт сейчас недоступен.", "error", 4600);
      return;
    }

    const yieldToUi = () => new Promise<void>((resolve) => window.setTimeout(resolve, 0));

    try {
      setExportProgress({ active: true, value: 5, label: "Подготовка заметок" });
      await yieldToUi();

      const notesForExport = await hydrateNotesAssets(notes);
      const total = Math.max(1, notesForExport.length);
      const notesWithFileData: Note[] = [];

      for (let i = 0; i < notesForExport.length; i += 1) {
        const note = notesForExport[i];
        const files = await Promise.all(
          note.files.map(async (file) => ({
            ...file,
            dataUrl: await resolveFileDataUrl(file),
          }))
        );
        notesWithFileData.push({ ...note, files });
        setExportProgress({
          active: true,
          value: 5 + Math.round(((i + 1) / total) * 55),
          label: "Сбор вложений",
        });
        if (i % 3 === 0) await yieldToUi();
      }

      const plainPayload: PlainExportPayload = {
        version: 4,
        exportedAt: new Date().toISOString(),
        notes: notesWithFileData,
        sectionOrder,
      };

      setExportProgress({ active: true, value: 72, label: "Шифрование" });
      await yieldToUi();
      const encryptedPayload = await encryptPayload(plainPayload, main_app);

      setExportProgress({ active: true, value: 90, label: "Формирование файла" });
      await yieldToUi();
      const blob = new Blob([JSON.stringify(encryptedPayload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      const fileStamp = new Intl.DateTimeFormat("ru-RU", {
        dateStyle: "short",
        timeStyle: "medium",
      })
        .format(new Date())
        .replace(/[\s,:.]+/g, "-");
      anchor.download = `data-${fileStamp}.json`;
      anchor.click();
      URL.revokeObjectURL(url);

      setExportProgress({ active: true, value: 100, label: "Готово" });
      pushToast("База знаний экспортирована (зашифровано).", "success");
    } finally {
      window.setTimeout(() => {
        setExportProgress({ active: false, value: 0, label: "" });
      }, 700);
    }
  }

  async function importNotes(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const { notes: importedNotes, sectionOrder: importedOrder } = await parseImportedText(text);

      setNotes(importedNotes);
      if (importedOrder) setSectionOrder(importedOrder);
      setExpandedSections(new Set());
      setSearchQuery("");
      pushToast("База знаний успешно импортирована.", "success");
    } catch {
      pushToast("Ошибка импорта. Проверьте JSON файл.", "error");
    } finally {
      event.target.value = "";
    }
  }

  async function mergeNotesFromFile(event: ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      const text = await file.text();
      const { notes: incoming, sectionOrder: incomingOrder } = await parseImportedText(text);
      const merged = mergeByUuid(notes, incoming);
      setNotes(merged);

      if (incomingOrder) {
        setSectionOrder((current) => {
          const result = [...current];
          for (const section of incomingOrder) {
            if (!result.includes(section)) result.push(section);
          }
          return result;
        });
      }

      pushToast("Слияние завершено: применены самые свежие версии по UUID/updatedAt.", "success", 4200);
    } catch {
      pushToast("Ошибка слияния. Проверьте формат и ключ шифрования.", "error", 4200);
    } finally {
      event.target.value = "";
    }
  }

  return (
    <div className={`min-h-screen transition-colors duration-300 ${isDark ? "bg-[#1B1B1B] text-[#FFF7EE]" : "bg-[#FFF9F2] text-[#2A2A2A]"}`}>
      <header className={`${isDark ? "border-[#5A3416] bg-[#1E1E1E]/92" : "border-[#FFD1A6] bg-white/92"} sticky top-0 z-20 border-b shadow-sm backdrop-blur`}>
        <div className="mx-auto flex w-full max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-4 md:px-6">
          <div>
            <p className={`text-xs uppercase tracking-[0.18em] ${isDark ? "text-[#FFD7B3]" : "text-[#B35A00]"}`}>База знаний</p>
            <button type="button" onClick={handleLogoClick} className="cursor-pointer">
              <img src={LOGO_SRC} alt="СОСЕДИ" className="h-8 w-auto" />
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={openCreateModal}
              className={`${isDark ? "bg-[#FF7A01] text-white hover:bg-[#FF9C45]" : "bg-[#FF7A01] text-white hover:bg-[#E86F00]"} rounded-xl px-3 py-2 text-sm font-semibold transition`}
            >
              Создать
            </button>
            <button
              type="button"
              onClick={exportNotes}
              className={`${isDark ? "bg-[#3D2B1E] hover:bg-[#5A3D2A]" : "bg-[#FFF1E3] hover:bg-[#FFE3CC]"} rounded-xl px-3 py-2 text-sm font-medium transition`}
            >
              Экспорт
            </button>
            <button
              type="button"
              onClick={() => importInputRef.current?.click()}
              className={`${isDark ? "bg-[#3D2B1E] hover:bg-[#5A3D2A]" : "bg-[#FFF1E3] hover:bg-[#FFE3CC]"} rounded-xl px-3 py-2 text-sm font-medium transition`}
            >
              Импорт
            </button>
            <button
              type="button"
              onClick={() => mergeInputRef.current?.click()}
              className={`${isDark ? "bg-[#3D2B1E] hover:bg-[#5A3D2A]" : "bg-[#FFF1E3] hover:bg-[#FFE3CC]"} rounded-xl px-3 py-2 text-sm font-medium transition`}
            >
              Слияние
            </button>
            <button
              type="button"
              onClick={toggleThemeSmooth}
              className={`${isDark ? "bg-[#FF7A01] text-white hover:bg-[#FF9C45]" : "bg-[#FF7A01] text-white hover:bg-[#E86F00]"} rounded-xl px-3 py-2 text-sm font-medium transition`}
            >
              {isDark ? "Дневная" : "Ночная"} тема
            </button>
            <input ref={importInputRef} type="file" accept="application/json" className="hidden" onChange={importNotes} />
            <input ref={mergeInputRef} type="file" accept="application/json" className="hidden" onChange={mergeNotesFromFile} />
          </div>
        </div>
      </header>

      {APP_VIEW_HINT && (
        <div className="pointer-events-none fixed left-2 top-1/2 z-0 hidden -translate-y-1/2 rotate-180 [writing-mode:vertical-rl] text-xs tracking-[0.2em] opacity-45 md:block">
          {APP_VIEW_HINT}
        </div>
      )}

      <main className="relative z-10 mx-auto w-full max-w-5xl space-y-4 px-4 py-6 md:px-6">
        <section className={`${isDark ? "border-[#5A3416] bg-[#242424] shadow-black/20" : "border-[#FFD1A6] bg-white shadow-orange-100/70"} rounded-3xl border p-4 shadow-lg`}>
          <label className="mb-2 block text-sm font-medium">Умный поиск по разделу, проблеме и решению</label>
          <input
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Например: висы ни на свези"
            className={`${
              isDark
                ? "border-[#9A5A26] bg-[#2B2B2B] text-[#FFF7EE] focus:ring-[#FF9C45]"
                : "border-[#FFBF87] bg-[#FFFAF5] text-[#2A2A2A] focus:ring-[#FF7A01]"
            } w-full rounded-xl border px-3 py-2.5 text-sm outline-none transition focus:ring-2`}
          />
        </section>

        {groupedResults.length === 0 && (
          <div className={`${isDark ? "border-[#5A3416] bg-[#242424] text-[#FFD9B7] shadow-black/20" : "border-[#FFD1A6] bg-white text-[#A3530A] shadow-orange-100/70"} rounded-3xl border p-6 text-sm shadow-lg`}>
            Ничего не найдено. Попробуйте уточнить запрос или добавить новую заметку.
          </div>
        )}

        <section className="space-y-3">
          {groupedResults.map(([section, results], sectionIndex) => {
            const expanded = searchQuery.trim() ? autoExpandedSections.has(section) : expandedSections.has(section);

            return (
              <div key={section} className={`${isDark ? "border-[#5A3416] bg-[#242424] shadow-black/15" : "border-[#FFD1A6] bg-white shadow-orange-100/60"} rounded-3xl border shadow-md`}>
                <div className="flex items-center gap-3 px-4 py-3">
                  <button type="button" onClick={() => toggleSection(section)} className="min-w-0 flex-1 text-left">
                    <h2 className="text-base font-semibold break-words [overflow-wrap:anywhere]">{highlightText(section, searchQuery)}</h2>
                    <p className={`text-xs ${isDark ? "text-[#FFCDA5]" : "text-[#A3530A]"}`}>{results.length} заметок</p>
                  </button>
                  <div className="flex items-center gap-1.5">
                    <button
                      type="button"
                      onClick={() => moveSection(section, -1)}
                      disabled={sectionIndex === 0}
                      className={`${
                        isDark ? "bg-[#3D2B1E] text-[#FFD9B7]" : "bg-[#FFE9D4] text-[#A3530A]"
                      } rounded px-1.5 py-0.5 text-xs disabled:cursor-not-allowed disabled:opacity-40`}
                      title="Поднять раздел"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      onClick={() => moveSection(section, 1)}
                      disabled={sectionIndex === groupedResults.length - 1}
                      className={`${
                        isDark ? "bg-[#3D2B1E] text-[#FFD9B7]" : "bg-[#FFE9D4] text-[#A3530A]"
                      } rounded px-1.5 py-0.5 text-xs disabled:cursor-not-allowed disabled:opacity-40`}
                      title="Опустить раздел"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleSection(section)}
                      className={`ml-1 text-lg transition-transform duration-300 ease-out ${expanded ? "rotate-180" : "rotate-0"}`}
                      title={expanded ? "Свернуть" : "Развернуть"}
                    >
                      ⌄
                    </button>
                  </div>
                </div>

                <div
                  className={`grid overflow-hidden transition-[grid-template-rows,opacity] duration-200 ease-out ${
                    expanded ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
                  }`}
                >
                  <div className="overflow-hidden">
                    <div className={`${isDark ? "border-[#5A3416]" : "border-[#FFE3CC]"} space-y-3 border-t px-4 pb-4 pt-3`}>
                        {results.map(({ note, score }) => {
                          const copyTextLabel = copiedTextNoteId === note.id ? "Скопировано" : "Копировать ответ";
                          const isMatched = Boolean(searchQuery.trim());
                          const hasProblem = Boolean(htmlToText(note.problemDescription).trim());

                          return (
                            <article
                              key={note.id}
                              className={`rounded-2xl border p-3 ${
                                isMatched
                                  ? isDark
                                    ? "border-[#FF9C45] bg-[#4A2C16]/35"
                                    : "border-[#FFB36E] bg-[#FFF4E8]"
                                  : isDark
                                    ? "border-[#9A5A26] bg-[#1E1E1E]"
                                    : "border-[#FFE3CC] bg-[#FFFAF5]"
                              }`}
                            >
                              <div className="flex flex-wrap items-start justify-between gap-2">
                                <h3 className="text-sm font-semibold break-words [overflow-wrap:anywhere]">{highlightText(note.title, searchQuery)}</h3>
                                <div className="flex flex-wrap items-center gap-2">
                                  {isMatched && (
                                    <span className={`${isDark ? "bg-[#5A3416] text-[#FFD9B7]" : "bg-[#FFE7CF] text-[#B35A00]"} rounded-full px-2 py-0.5 text-xs`}>
                                      {Math.round(score * 100)}%
                                    </span>
                                  )}
                                  <button
                                    type="button"
                                    onClick={() => openEditModal(note)}
                                    className={`${isDark ? "bg-[#3D2B1E] hover:bg-[#5A3D2A]" : "bg-[#FFF1E3] hover:bg-[#FFE3CC]"} rounded-lg px-2 py-1 text-xs font-medium transition`}
                                  >
                                    Редактировать
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleDeleteNote(note)}
                                    className={`${isDark ? "bg-[#6B2C2C] hover:bg-[#863737]" : "bg-[#F8D7D7] text-[#6B2C2C] hover:bg-[#F2C6C6]"} rounded-lg px-2 py-1 text-xs font-medium transition`}
                                  >
                                    Удалить
                                  </button>
                                </div>
                              </div>

                              {note.files.length > 0 && (
                                <div className="mt-3">
                                  <p className={`mb-2 text-xs font-semibold uppercase tracking-wide ${isDark ? "text-[#FFCDA5]" : "text-[#A3530A]"}`}>Файлы</p>
                                  <div className="space-y-1.5">
                                    {note.files.map((file) => (
                                      <div
                                        key={file.id}
                                        className={`flex flex-wrap items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-xs ${
                                          isDark ? "bg-[#2A2A2A]" : "bg-[#FFF1E5]"
                                        }`}
                                      >
                                        <span className="break-all">
                                          {file.name} ({formatFileSize(file.size)})
                                        </span>
                                        <button
                                          type="button"
                                          onClick={() => downloadFile(file)}
                                          className={`${isDark ? "bg-[#5A3D2A] text-[#FFF7EE] hover:bg-[#714C33]" : "bg-[#FFE9D4] text-[#A3530A] hover:bg-[#FFD9B8]"} rounded px-2 py-1 transition`}
                                        >
                                          Скачать
                                        </button>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}

                              {hasProblem && (
                                <div className="mt-3">
                                  <p className={`text-xs font-semibold uppercase tracking-wide ${isDark ? "text-[#FFCDA5]" : "text-[#A3530A]"}`}>Проблема</p>
                                  <div
                                    className="rich-content mt-1 break-words [overflow-wrap:anywhere] text-sm"
                                    dangerouslySetInnerHTML={{ __html: highlightHtmlContent(note.problemDescription, searchQuery) }}
                                  />
                                </div>
                              )}

                              {note.problemImages.length > 0 && (
                                <div className="mt-3">
                                  <p className={`mb-2 text-xs font-semibold uppercase tracking-wide ${isDark ? "text-[#FFCDA5]" : "text-[#A3530A]"}`}>Фото проблемы</p>
                                  <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                                    {note.problemImages.map((image, index) => {
                                      const copiedLabel = copiedImageId === image.id ? "Скопировано" : "Копировать";
                                      return (
                                        <div key={image.id} className="group relative overflow-hidden rounded-lg">
                                          <button
                                            type="button"
                                            onClick={() => openImageViewer(note.problemImages, index, "Фото проблемы")}
                                            className="block w-full"
                                            title="Открыть на весь экран"
                                          >
                                            <img src={image.dataUrl} alt={image.name} className="h-28 w-full object-cover transition duration-300 group-hover:scale-105" />
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => copyImageToClipboard(image)}
                                            className={`${copiedImageId === image.id ? "bg-[#FF7A01]" : "bg-black/75"} absolute bottom-1 right-1 rounded px-2 py-1 text-xs text-white transition`}
                                          >
                                            {copiedLabel}
                                          </button>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              )}

                              <div
                                className={`mt-4 rounded-lg border-l-4 p-3 ${
                                  isDark ? "border-[#FF7A01] bg-[#3A2617]" : "border-[#FF7A01] bg-[#FFF1E5]"
                                }`}
                              >
                                <div className="flex items-start justify-between gap-2">
                                  <p className="text-xs font-semibold uppercase tracking-wide text-[#FF7A01]">Ответ / Решение</p>
                                  <button
                                    type="button"
                                    onClick={() => copyNoteText(note)}
                                    className={`${
                                      copiedTextNoteId === note.id
                                        ? "bg-[#FF7A01] text-white"
                                        : isDark
                                          ? "bg-[#5A3D2A] text-[#FFF7EE] hover:bg-[#714C33]"
                                          : "bg-[#FFE9D4] text-[#A3530A] hover:bg-[#FFD9B8]"
                                    } rounded-lg px-2 py-1 text-xs font-medium transition`}
                                  >
                                    {copyTextLabel}
                                  </button>
                                </div>
                                <div
                                  className="rich-content mt-1 break-words [overflow-wrap:anywhere] text-sm"
                                  dangerouslySetInnerHTML={{ __html: highlightHtmlContent(note.solutionText, searchQuery) }}
                                />
                              </div>

                              {note.solutionImages.length > 0 && (
                                <div
                                  className={`mt-3 rounded-lg border-l-4 p-3 ${
                                    isDark ? "border-[#FF7A01] bg-[#3A2617]" : "border-[#FF7A01] bg-[#FFF1E5]"
                                  }`}
                                >
                                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-[#FF7A01]">Фото ответа</p>
                                  <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                                    {note.solutionImages.map((image, index) => {
                                      const copiedLabel = copiedImageId === image.id ? "Скопировано" : "Копировать";
                                      return (
                                        <div key={image.id} className="group relative overflow-hidden rounded-lg">
                                          <button
                                            type="button"
                                            onClick={() => openImageViewer(note.solutionImages, index, "Фото ответа")}
                                            className="block w-full"
                                            title="Открыть на весь экран"
                                          >
                                            <img src={image.dataUrl} alt={image.name} className="h-28 w-full object-cover transition duration-300 group-hover:scale-105" />
                                          </button>
                                          <button
                                            type="button"
                                            onClick={() => copyImageToClipboard(image)}
                                            className={`${copiedImageId === image.id ? "bg-[#FF7A01]" : "bg-black/75"} absolute bottom-1 right-1 rounded px-2 py-1 text-xs text-white transition`}
                                          >
                                            {copiedLabel}
                                          </button>
                                        </div>
                                      );
                                    })}
                                  </div>
                                </div>
                              )}
                            </article>
                          );
                        })}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </section>
      </main>

      <AnimatePresence>
        {isEditorOpen && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <motion.form
              initial={{ opacity: 0, scale: 0.96, y: 16 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.98, y: 8 }}
              transition={{ duration: 0.22 }}
              onSubmit={handleSaveNote}
              onClick={(event) => event.stopPropagation()}
              className={`${isDark ? "border-[#9A5A26] bg-[#1E1E1E] shadow-black/25" : "border-[#FFD1A6] bg-white shadow-orange-200/70"} max-h-[92vh] w-full max-w-3xl overflow-y-auto rounded-3xl border p-5 shadow-xl`}
            >
              <div className="mb-4 flex items-center justify-between gap-3">
                <h2 className="text-lg font-semibold">{editingNoteId ? "Редактировать заметку" : "Новая заметка"}</h2>
                <button
                  type="button"
                  onClick={() => setIsEditorOpen(false)}
                  className={`${isDark ? "bg-[#3D2B1E] hover:bg-[#5A3D2A]" : "bg-[#FFF1E3] hover:bg-[#FFE3CC]"} rounded-lg px-3 py-1.5 text-sm transition`}
                >
                  Закрыть
                </button>
              </div>

              <div className="space-y-4">
                <div className="space-y-2">
                  <label className="text-sm font-medium">Раздел</label>
                  <select
                    value={draft.selectedSection}
                    onChange={(event) => setDraft((previous) => ({ ...previous, selectedSection: event.target.value }))}
                    className={`${
                      isDark
                        ? "border-[#9A5A26] bg-[#2B2B2B] text-[#FFF7EE] focus:ring-[#FF9C45]"
                        : "border-[#FFBF87] bg-[#FFFAF5] text-[#2A2A2A] focus:ring-[#FF7A01]"
                    } w-full rounded-xl border px-3 py-2 text-sm outline-none transition focus:ring-2`}
                  >
                    {sections.map((section) => (
                      <option key={section} value={section}>
                        {section}
                      </option>
                    ))}
                    <option value={NEW_SECTION_VALUE}>+ Новый раздел</option>
                  </select>
                  {draft.selectedSection === NEW_SECTION_VALUE && (
                    <input
                      value={draft.newSection}
                      onChange={(event) => setDraft((previous) => ({ ...previous, newSection: event.target.value }))}
                      placeholder="Например: Касса, ТСД, Принтеры"
                      className={`${
                        isDark
                          ? "border-[#9A5A26] bg-[#2B2B2B] text-[#FFF7EE] focus:ring-[#FF9C45]"
                          : "border-[#FFBF87] bg-[#FFFAF5] text-[#2A2A2A] focus:ring-[#FF7A01]"
                      } w-full rounded-xl border px-3 py-2 text-sm outline-none transition focus:ring-2`}
                    />
                  )}
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Заголовок</label>
                  <input
                    value={draft.title}
                    onChange={(event) => setDraft((previous) => ({ ...previous, title: event.target.value }))}
                    placeholder="Коротко: что случилось"
                    className={`${
                      isDark
                        ? "border-[#9A5A26] bg-[#2B2B2B] text-[#FFF7EE] focus:ring-[#FF9C45]"
                        : "border-[#FFBF87] bg-[#FFFAF5] text-[#2A2A2A] focus:ring-[#FF7A01]"
                    } w-full rounded-xl border px-3 py-2 text-sm outline-none transition focus:ring-2`}
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Описание проблемы</label>
                  <RichTextEditor
                    value={draft.problemDescription}
                    onChange={(value) => setDraft((previous) => ({ ...previous, problemDescription: value }))}
                    isDark={isDark}
                    placeholder="Что именно не работает"
                    minHeight="120px"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Фото проблемы (можно несколько)</label>
                
                  <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                    <label
                      className={`flex cursor-pointer items-center justify-center rounded-xl border px-3 py-2 text-xs font-medium transition ${
                        isDark
                          ? "border-[#9A5A26] bg-[#2B2B2B] text-[#FFD9B7] hover:bg-[#3A2D2D]"
                          : "border-[#FFBF87] bg-[#FFFAF5] text-[#A3530A] hover:bg-[#FFF2E6]"
                      }`}
                    >
                      Выбрать из файлов
                      <input
                        type="file"
                        accept="image/*"
                        multiple
                        onChange={(event) => handleAddImages(event, "problemImages")}
                        className="hidden"
                      />
                    </label>
                
                    <div
                      tabIndex={0}
                      role="button"
                      onPaste={(event) => void handlePasteImages(event, "problemImages")}
                      className={`flex items-center justify-center rounded-xl border border-dashed px-3 py-2 text-center text-xs font-medium outline-none transition ${
                        isDark
                          ? "border-[#9A5A26] bg-[#2A2A2A] text-[#FFD9B7] hover:bg-[#3A2D2D] focus:ring-2 focus:ring-[#FF9C45]"
                          : "border-[#FFBF87] bg-[#FFF6EE] text-[#A3530A] hover:bg-[#FFF2E6] focus:ring-2 focus:ring-[#FF7A01]"
                      }`}
                    >
                      Нажмите сюда и вставьте Ctrl+V
                    </div>
                  </div>
                
                  {draft.problemImages.length > 0 && (
                    <div className="grid grid-cols-3 gap-2">
                      {draft.problemImages.map((image) => (
                        <div key={image.id} className="relative overflow-hidden rounded-lg">
                          <img src={image.dataUrl} alt={image.name} className="h-20 w-full object-cover" />
                          <button
                            type="button"
                            onClick={() => removeDraftImage("problemImages", image.id)}
                            className="absolute right-1 top-1 rounded bg-black/75 px-1.5 py-0.5 text-xs text-white"
                          >
                            x
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Решение</label>
                  <RichTextEditor
                    value={draft.solutionText}
                    onChange={(value) => setDraft((previous) => ({ ...previous, solutionText: value }))}
                    isDark={isDark}
                    placeholder="Как решить проблему"
                    minHeight="170px"
                  />
                </div>

                <div className="space-y-2">
                  <label className="text-sm font-medium">Файлы к заметке</label>
                
                  <label
                    className={`flex cursor-pointer items-center justify-center rounded-xl border px-3 py-2 text-xs font-medium transition ${
                      isDark
                        ? "border-[#9A5A26] bg-[#2B2B2B] text-[#FFD9B7] hover:bg-[#3A2D2D]"
                        : "border-[#FFBF87] bg-[#FFFAF5] text-[#A3530A] hover:bg-[#FFF2E6]"
                    }`}
                  >
                    Выбрать файл
                    <input type="file" multiple onChange={handleAddFiles} className="hidden" />
                  </label>
                
                  {draft.files.length > 0 && (
                    <div className="space-y-1.5">
                      {draft.files.map((file) => (
                        <div
                          key={file.id}
                          className={`flex flex-wrap items-center justify-between gap-2 rounded-lg px-2 py-1.5 text-xs ${
                            isDark ? "bg-[#2A2A2A]" : "bg-[#FFF1E5]"
                          }`}
                        >
                          <span className="break-all">
                            {file.name} ({formatFileSize(file.size)})
                          </span>
                          <button
                            type="button"
                            onClick={() => removeDraftFile(file.id)}
                            className="rounded bg-black/70 px-2 py-1 text-white transition hover:bg-black/80"
                          >
                            Удалить
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                  <div className="space-y-2">
                    <label className="text-sm font-medium">Фото решения (можно несколько)</label>
                  
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                      <label
                        className={`flex cursor-pointer items-center justify-center rounded-xl border px-3 py-2 text-xs font-medium transition ${
                          isDark
                            ? "border-[#9A5A26] bg-[#2B2B2B] text-[#FFD9B7] hover:bg-[#3A2D2D]"
                            : "border-[#FFBF87] bg-[#FFFAF5] text-[#A3530A] hover:bg-[#FFF2E6]"
                        }`}
                      >
                        Выбрать из файлов
                        <input
                          type="file"
                          accept="image/*"
                          multiple
                          onChange={(event) => handleAddImages(event, "solutionImages")}
                          className="hidden"
                        />
                      </label>
                  
                      <div
                        tabIndex={0}
                        role="button"
                        onPaste={(event) => void handlePasteImages(event, "solutionImages")}
                        className={`flex items-center justify-center rounded-xl border border-dashed px-3 py-2 text-center text-xs font-medium outline-none transition ${
                          isDark
                            ? "border-[#9A5A26] bg-[#2A2A2A] text-[#FFD9B7] hover:bg-[#3A2D2D] focus:ring-2 focus:ring-[#FF9C45]"
                            : "border-[#FFBF87] bg-[#FFF6EE] text-[#A3530A] hover:bg-[#FFF2E6] focus:ring-2 focus:ring-[#FF7A01]"
                        }`}
                      >
                        Нажмите сюда и вставьте Ctrl+V
                      </div>
                    </div>
                  
                    {draft.solutionImages.length > 0 && (
                      <div className="grid grid-cols-3 gap-2">
                        {draft.solutionImages.map((image) => (
                          <div key={image.id} className="relative overflow-hidden rounded-lg">
                            <img src={image.dataUrl} alt={image.name} className="h-20 w-full object-cover" />
                            <button
                              type="button"
                              onClick={() => removeDraftImage("solutionImages", image.id)}
                              className="absolute right-1 top-1 rounded bg-black/75 px-1.5 py-0.5 text-xs text-white"
                            >
                              x
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                <button
                  type="submit"
                  className={`${isDark ? "bg-[#FF7A01] text-white hover:bg-[#FF9C45]" : "bg-[#FF7A01] text-white hover:bg-[#E86F00]"} w-full rounded-xl px-4 py-2.5 text-sm font-semibold transition`}
                >
                  {editingNoteId ? "Сохранить изменения" : "Сохранить заметку"}
                </button>
              </div>
            </motion.form>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {activeGallery && activeImage && (
          <motion.div
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/88 p-6"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setActiveGallery(null)}
            onWheel={(event) => {
              if (activeGallery.images.length < 2) return;
              if (event.deltaY > 0) shiftImage(1);
              if (event.deltaY < 0) shiftImage(-1);
            }}
          >
            {activeGallery.images.length > 1 && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  shiftImage(-1);
                }}
                className="absolute left-4 top-1/2 -translate-y-1/2 rounded-full bg-black/55 px-3 py-2 text-2xl text-white"
                aria-label="Предыдущее фото"
              >
                ‹
              </button>
            )}

            <motion.img
              key={activeImage.id}
              initial={{ scale: 0.92, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.92, opacity: 0 }}
              transition={{ duration: 0.2, ease: "easeOut" }}
              src={activeImage.dataUrl}
              alt={activeImage.name}
              className="max-h-full max-w-full object-contain"
              onClick={(event) => event.stopPropagation()}
            />

            <div className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded bg-black/60 px-3 py-1 text-xs text-white">
              {activeGallery.label}
              {activeGallery.images.length > 1 ? ` ${activeGallery.index + 1}/${activeGallery.images.length}` : ""}
            </div>

            {activeGallery.images.length > 1 && (
              <button
                type="button"
                onClick={(event) => {
                  event.stopPropagation();
                  shiftImage(1);
                }}
                className="absolute right-4 top-1/2 -translate-y-1/2 rounded-full bg-black/55 px-3 py-2 text-2xl text-white"
                aria-label="Следующее фото"
              >
                ›
              </button>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <div className="pointer-events-none fixed right-4 top-4 z-[60] flex w-full max-w-sm flex-col gap-2">
        <AnimatePresence>
          {exportProgress.active && (
            <motion.div
              initial={{ opacity: 0, y: -10, scale: 0.98 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -8, scale: 0.98 }}
              className={`pointer-events-auto rounded-2xl border px-3 py-2 text-sm shadow-lg ${
                isDark ? "border-[#9A5A26] bg-[#2B2B2B] text-[#FFF7EE]" : "border-[#FFD1A6] bg-white text-[#A3530A]"
              }`}
            >
              <div className="mb-1 flex items-center justify-between gap-2 text-xs">
                <span>{exportProgress.label}</span>
                <span>{exportProgress.value}%</span>
              </div>
              <div className={`h-2 overflow-hidden rounded-full ${isDark ? "bg-black/35" : "bg-orange-100"}`}>
                <motion.div
                  className="h-full bg-[#FF7A01]"
                  animate={{ width: `${exportProgress.value}%` }}
                  transition={{ duration: 0.2, ease: "easeOut" }}
                />
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <AnimatePresence>
          {toasts.map((toast) => (
            <motion.div
              key={toast.id}
              initial={{ opacity: 0, y: -12, scale: 0.97 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: -10, scale: 0.97 }}
              className={`pointer-events-auto rounded-2xl border px-3 py-2 text-sm shadow-lg ${
                toast.kind === "error"
                  ? isDark
                    ? "border-rose-500/70 bg-rose-500/15 text-rose-100"
                    : "border-rose-300 bg-rose-50 text-rose-700"
                  : toast.kind === "success"
                    ? isDark
                      ? "border-emerald-500/60 bg-emerald-500/15 text-emerald-100"
                      : "border-emerald-300 bg-emerald-50 text-emerald-700"
                    : isDark
                      ? "border-[#9A5A26] bg-[#2B2B2B] text-[#FFF7EE]"
                      : "border-[#FFD1A6] bg-white text-[#A3530A]"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <p className="leading-snug">{toast.message}</p>
                <button type="button" onClick={() => removeToast(toast.id)} className="opacity-70 transition hover:opacity-100">
                  x
                </button>
              </div>
            </motion.div>
          ))}
        </AnimatePresence>
      </div>

      <AnimatePresence>
        {themeCurtain.visible && (
          <motion.div
            className="pointer-events-none fixed inset-0 z-[75]"
            style={{ backgroundColor: themeCurtain.color }}
            initial={{ opacity: 1 }}
            animate={{ opacity: themeCurtain.opacity }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.24, ease: "easeOut" }}
          />
        )}
      </AnimatePresence>

    </div>
  );
}
