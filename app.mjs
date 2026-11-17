import { parseBGLModels, convertModelToGLB, modelOutputName } from "./converter-core.mjs";

const $ = id => document.getElementById(id);
const fileInput = $("files");
const analyzeButton = $("analyze");
const convertButton = $("convert");
const resetButton = $("reset");
const modelList = $("model-list");
const results = $("results");
const statusText = $("status-text");
const progress = $("progress");
const progressFill = $("progress-fill");
const logBox = $("log");

let assetRecords = [];
let models = [];
let outputURLs = [];

function log(message, type = "info") {
  const line = document.createElement("div");
  line.className = `log-line ${type}`;
  const time = new Date().toLocaleTimeString("ja-JP", { hour12: false });
  line.textContent = `[${time}] ${message}`;
  logBox.prepend(line);
}

function setStatus(message, percent = null) {
  statusText.textContent = message;
  if (percent === null) {
    progress.hidden = true;
  } else {
    progress.hidden = false;
    progressFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
  }
}

function revokeURLs() {
  for (const url of outputURLs) URL.revokeObjectURL(url);
  outputURLs = [];
}

function clearState() {
  revokeURLs();
  assetRecords = [];
  models = [];
  modelList.replaceChildren();
  results.replaceChildren();
  logBox.replaceChildren();
  convertButton.disabled = true;
  setStatus("ファイルを選択してください。", null);
}

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\/+/, "");
}

async function collectAssets(files) {
  const records = [];
  for (const file of files) {
    const lower = file.name.toLowerCase();
    if (lower.endsWith(".zip")) {
      if (!window.JSZip) throw new Error("ZIPライブラリを読み込めませんでした。ページを再読み込みしてください。");
      log(`ZIPを展開しています: ${file.name}`);
      const zip = await window.JSZip.loadAsync(file);
      for (const [path, entry] of Object.entries(zip.files)) {
        if (entry.dir) continue;
        records.push({
          path: normalizePath(path),
          basename: normalizePath(path).split("/").pop().toLowerCase(),
          load: () => entry.async("uint8array")
        });
      }
    } else {
      records.push({
        path: file.name,
        basename: file.name.toLowerCase(),
        load: async () => new Uint8Array(await file.arrayBuffer())
      });
    }
  }
  return records;
}

function makeAssetResolver(records) {
  const byBasename = new Map();
  for (const record of records) {
    const list = byBasename.get(record.basename) || [];
    list.push(record);
    byBasename.set(record.basename, list);
  }
  const byteCache = new Map();
  return async uri => {
    const basename = normalizePath(uri).split("/").pop().toLowerCase();
    const matches = byBasename.get(basename);
    if (!matches || !matches.length) return null;
    const best = matches.find(item => item.path.toLowerCase().includes("/scenery/")) || matches[0];
    let bytes = byteCache.get(best.path);
    if (!bytes) {
      bytes = await best.load();
      byteCache.set(best.path, bytes);
    }
    return { path: best.path, bytes };
  };
}

function renderModels() {
  modelList.replaceChildren();
  if (!models.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = "モデルが見つかりません。ModelLib.BGLを含むZIP、またはModelLib.BGLを選択してください。";
    modelList.append(empty);
    convertButton.disabled = true;
    return;
  }

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const card = document.createElement("label");
    card.className = "model-card";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "model-check";
    checkbox.checked = true;
    checkbox.dataset.index = String(i);
    const detail = document.createElement("span");
    detail.className = "model-detail";
    const name = document.createElement("strong");
    name.textContent = model.modelName;
    const meta = document.createElement("small");
    const lodLabel = model.lodFile ? ` · ${model.lodFile}` : ` · LOD ${model.lodIndex}`;
    meta.textContent = `${model.bglName}${lodLabel}`;
    detail.append(name, meta);
    const badge = document.createElement("span");
    badge.className = "model-badge";
    badge.textContent = "GLB候補";
    card.append(checkbox, detail, badge);
    modelList.append(card);
  }
  convertButton.disabled = false;
}

function selectedModels() {
  const selected = [...modelList.querySelectorAll(".model-check:checked")];
  return selected.map(item => models[Number(item.dataset.index)]).filter(Boolean);
}

function addResultLink(name, blob) {
  const url = URL.createObjectURL(blob);
  outputURLs.push(url);
  const row = document.createElement("div");
  row.className = "result-row";
  const label = document.createElement("span");
  label.textContent = name;
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.textContent = "保存";
  row.append(label, link);
  results.append(row);
  return url;
}

async function downloadBlob(name, blob) {
  const url = URL.createObjectURL(blob);
  outputURLs.push(url);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
}

analyzeButton.addEventListener("click", async () => {
  const files = [...fileInput.files];
  if (!files.length) {
    setStatus("先にZIPまたはBGLファイルを選択してください。", null);
    return;
  }
  analyzeButton.disabled = true;
  convertButton.disabled = true;
  modelList.replaceChildren();
  results.replaceChildren();
  logBox.replaceChildren();
  models = [];
  revokeURLs();
  try {
    setStatus("ファイルを読み込んでいます…", 5);
    assetRecords = await collectAssets(files);
    const bgls = assetRecords.filter(item => item.basename.endsWith(".bgl"));
    if (!bgls.length) throw new Error("BGLファイルが見つかりません。ZIP内にBGLがあるか確認してください。");
    log(`ファイル ${assetRecords.length} 件 / BGL ${bgls.length} 件を確認しました。`);

    for (let i = 0; i < bgls.length; i++) {
      const item = bgls[i];
      setStatus(`BGLを解析中: ${item.path}`, 10 + (i / bgls.length) * 75);
      const bytes = await item.load();
      const found = parseBGLModels(bytes, item.path.split("/").pop());
      if (found.length) {
        models.push(...found);
        log(`${item.path}: モデル ${found.length} 件を抽出しました。`, "success");
      } else {
        log(`${item.path}: 埋め込みモデルなし（配置情報BGLの可能性があります）。`, "muted");
      }
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    renderModels();
    if (!models.length) {
      setStatus("モデルライブラリBGLが見つかりません。配置BGLだけでなく、対応する *modelLib.BGL を追加してください。", null);
    } else {
      const textureCount = assetRecords.filter(item => item.basename.endsWith(".dds")).length;
      setStatus(`モデル ${models.length} 件を検出しました。DDS ${textureCount} 件。変換対象を選択してください。`, null);
      log(`合計 ${models.length} モデルを検出しました。`, "success");
    }
  } catch (error) {
    console.error(error);
    setStatus(error.message || String(error), null);
    log(error.message || String(error), "error");
  } finally {
    analyzeButton.disabled = false;
  }
});

convertButton.addEventListener("click", async () => {
  const targets = selectedModels();
  if (!targets.length) {
    setStatus("変換するモデルにチェックを入れてください。", null);
    return;
  }
  if (!window.JSZip) {
    setStatus("ZIPライブラリを読み込めませんでした。", null);
    return;
  }

  analyzeButton.disabled = true;
  convertButton.disabled = true;
  results.replaceChildren();
  revokeURLs();
  const resolveAsset = makeAssetResolver(assetRecords);
  const converted = [];
  const nameCounts = new Map();
  let completed = 0;

  try {
    for (const model of targets) {
      const baseName = modelOutputName(model);
      const nameCount = (nameCounts.get(baseName) || 0) + 1;
      nameCounts.set(baseName, nameCount);
      const name = nameCount === 1
        ? baseName
        : baseName.replace(/\.glb$/i, `_${String(nameCount).padStart(2, "0")}.glb`);
      setStatus(`変換中: ${model.modelName} (${completed + 1}/${targets.length})`, (completed / targets.length) * 90);
      log(`${model.modelName} のジオメトリを変換しています…`);
      const output = await convertModelToGLB(model, resolveAsset, {
        onProgress: info => {
          if (info.phase === "geometry") {
            setStatus(`${model.modelName}: メッシュ ${info.current}/${info.total}`, ((completed + info.current / Math.max(1, info.total)) / targets.length) * 90);
          } else if (info.phase === "textures") {
            setStatus(`${model.modelName}: テクスチャ ${info.current}/${info.total}`, ((completed + 0.9) / targets.length) * 90);
          }
        }
      });
      const blob = new Blob([output.bytes], { type: "model/gltf-binary" });
      converted.push({ name, blob });
      addResultLink(name, blob);
      completed++;
      log(`${name} を生成しました（${(output.bytes.length / 1024 / 1024).toFixed(1)} MB）。`, "success");
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    if (converted.length === 1) {
      await downloadBlob(converted[0].name, converted[0].blob);
      setStatus("GLB変換が完了しました。", 100);
    } else {
      setStatus("変換済みGLBをZIPにまとめています…", 94);
      const zip = new window.JSZip();
      for (const item of converted) zip.file(item.name, item.blob);
      const zipBlob = await zip.generateAsync({ type: "blob", compression: "STORE" }, meta => {
        setStatus(`ZIP作成中 ${meta.percent.toFixed(0)}%`, 94 + meta.percent * 0.06);
      });
      addResultLink("BGL_to_GLB_converted.zip", zipBlob);
      await downloadBlob("BGL_to_GLB_converted.zip", zipBlob);
      setStatus(`${converted.length} 個のGLBをZIPにまとめました。`, 100);
    }
  } catch (error) {
    console.error(error);
    setStatus(error.message || String(error), null);
    log(error.message || String(error), "error");
    log("不足テクスチャ、未対応DDS形式、またはメモリ不足の可能性があります。ZIP全体を選ぶか、1モデルずつ変換してください。", "muted");
  } finally {
    analyzeButton.disabled = false;
    convertButton.disabled = false;
  }
});

resetButton.addEventListener("click", () => {
  fileInput.value = "";
  clearState();
});

fileInput.addEventListener("change", () => {
  const count = fileInput.files.length;
  if (count) setStatus(`${count} ファイルを選択しました。「BGLを解析」を押してください。`, null);
});

clearState();
