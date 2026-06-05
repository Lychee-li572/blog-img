/**
 * compress-images.js
 * 遍历仓库目录，压缩 JPG/PNG 图片（保持原格式），覆盖原图。
 *
 * 工作模式：
 *   1. 优先通过环境变量 GITHUB_EVENT_BEFORE / AFTER 做 git diff，只处理新增/修改的文件
 *   2. 若无法获取 diff（首次 push 等），回退到全仓库扫描
 *
 * 压缩参数：JPEG quality = 75（启用 mozjpeg）
 * 支持的格式：.jpg / .jpeg / .png
 */

const sharp = require("sharp");
const fs   = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ==================== 配置 ====================
const JPEG_QUALITY     = 75;
const ALLOWED_EXTS     = [".jpg", ".jpeg", ".png"];
const EXCLUDE_DIRS     = ["node_modules", ".git", ".github", "scripts"];

// ==================== 工具 ====================

/** 递归扫描目录，返回所有允许的图片文件路径（排除特定目录） */
function scanAllImageFiles(rootDir) {
  const results = [];
  if (!fs.existsSync(rootDir)) return results;

  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  for (const entry of entries) {
    if (EXCLUDE_DIRS.includes(entry.name)) continue;

    const fullPath = path.join(rootDir, entry.name);
    if (entry.isDirectory()) {
      results.push(...scanAllImageFiles(fullPath));
    } else {
      const ext = path.extname(entry.name).toLowerCase();
      if (ALLOWED_EXTS.includes(ext)) {
        results.push(path.normalize(fullPath));
      }
    }
  }
  return results;
}

/** 通过 git diff 获取本次 push 新增/修改的图片；失败则回退到全量扫描 */
function getChangedImageFiles() {
  const before = process.env.GITHUB_EVENT_BEFORE;
  const after  = process.env.GITHUB_EVENT_AFTER;

  if (!before || !after || /^0+$/.test(before)) {
    console.log("⚡ 首次 push 或无法获取 diff，执行全仓库扫描");
    return scanAllImageFiles(".");
  }

  try {
    const diff = execSync(
      `git diff --name-only --diff-filter=AM ${before} ${after}`,
      { encoding: "utf8" }
    ).trim();

    if (!diff) return [];

    return diff
      .split("\n")
      .map(f => f.trim())
      .filter(f => {
        const ext = path.extname(f).toLowerCase();
        // 跳过排除目录
        for (const d of EXCLUDE_DIRS) {
          if (f.startsWith(d + path.sep) || f === d) return false;
        }
        return ALLOWED_EXTS.includes(ext);
      });
  } catch (error) {
    console.warn("⚠️  git diff 获取失败，回退到全仓库扫描:", error.message);
    return scanAllImageFiles(".");
  }
}

// ==================== 核心 ====================

async function compressImage(filePath) {
  const tmpPath = filePath + ".tmp";

  const origSize = fs.statSync(filePath).size;

  const ext = path.extname(filePath).toLowerCase();
  let pipeline = sharp(filePath);
  if (ext === ".png") {
    pipeline = pipeline.png({ quality: JPEG_QUALITY });
  } else {
    pipeline = pipeline.jpeg({ quality: JPEG_QUALITY, mozjpeg: true });
  }

  await pipeline.toFile(tmpPath);

  const newSize = fs.statSync(tmpPath).size;
  const ratio   = ((1 - newSize / origSize) * 100).toFixed(1);

  // 如果压缩后更大或几乎没变化，保留原图
  if (newSize >= origSize * 0.98) {
    fs.unlinkSync(tmpPath);
    console.log(`  ⏭️  ${path.basename(filePath)} 已接近最佳压缩，跳过`);
    return;
  }

  // 用压缩后的文件替换原图
  fs.unlinkSync(filePath);
  fs.renameSync(tmpPath, filePath);

  console.log(`  ✓ ${path.basename(filePath)}`);
  console.log(`    ${(origSize / 1024).toFixed(1)} KB → ${(newSize / 1024).toFixed(1)} KB（-${ratio}%）`);
}

// ==================== 入口 ====================

async function main() {
  console.log("🔍 正在扫描待压缩图片...\n");

  const files = getChangedImageFiles();

  if (files.length === 0) {
    console.log("✅ 没有需要处理的图片，任务结束。");
    return;
  }

  console.log(`📸 发现 ${files.length} 张图片待处理:\n  ${files.join("\n  ")}\n`);
  console.log("🔄 开始压缩...\n");

  let success = 0;
  const errors = [];

  for (const file of files) {
    if (!fs.existsSync(file)) {
      console.log(`⏭️  跳过（已不存在）: ${file}`);
      continue;
    }
    try {
      await compressImage(file);
      success++;
    } catch (err) {
      console.error(`❌ 压缩失败: ${file} — ${err.message}`);
      errors.push({ file, error: err.message });
    }
  }

  console.log(`\n${"=".repeat(40)}`);
  console.log(`🎉 压缩完成！成功 ${success}/${files.length}`);
  if (errors.length) {
    console.log(`⚠️  失败 ${errors.length} 个:`);
    errors.forEach(e => console.log(`   - ${e.file}: ${e.error}`));
    process.exitCode = 1;
  }
  console.log(`${"=".repeat(40)}`);
}

main().catch(err => { console.error("💥 脚本异常:", err); process.exit(1); });
