import express from 'express';
import { exec } from 'child_process';
import { promisify } from 'util';
import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import { existsSync } from 'fs';

const execAsync = promisify(exec);

const app = express();
const PORT = 3005;

app.use(express.json());

// 辅助函数：通过 MacOS 的 du -sk 快速获取目录占用空间（单位：字节）
async function getDirSize(dirPath) {
  try {
    if (!existsSync(dirPath)) return 0;
    // 针对 Mac 优化的 du -sk 命令，处理特殊字符和空格
    const escapedPath = dirPath.replace(/(["\s'$`\\])/g, '\\$1');
    const { stdout } = await execAsync(`du -sk "${escapedPath}"`);
    const match = stdout.trim().match(/^(\d+)\s+/);
    if (match) {
      return parseInt(match[1], 10) * 1024;
    }
    return 0;
  } catch (err) {
    // 可能是无权限或目录被删除
    return 0;
  }
}

// 辅助函数：解析 df -k 获取 Mac 主分区磁盘空间
async function getDiskSpace() {
  try {
    let stdout;
    try {
      // 优先获取用户数据卷，因为 Mac Catalina 以后系统卷和数据卷分离，用户数据和应用主要在 /System/Volumes/Data
      const res = await execAsync('df -k /System/Volumes/Data');
      stdout = res.stdout;
    } catch (e) {
      const res = await execAsync('df -k /');
      stdout = res.stdout;
    }
    
    const lines = stdout.trim().split('\n');
    if (lines.length >= 2) {
      const parts = lines[1].split(/\s+/);
      const total = parseInt(parts[1], 10) * 1024;
      const used = parseInt(parts[2], 10) * 1024;
      const available = parseInt(parts[3], 10) * 1024;
      return { total, used, available };
    }
  } catch (err) {
    console.error('获取磁盘空间失败:', err);
  }
  return { total: 0, used: 0, available: 0 };
}

// 支持清理的目标文件夹及所属语言映射
const TARGET_DIR_MAP = {
  'node_modules': 'Node.js',
  'venv': 'Python',
  '.venv': 'Python',
  'env': 'Python',
  '.conda': 'Python (Conda)',
  'target': 'Rust (Cargo)',
  'Pods': 'CocoaPods',
  'build': 'Build Directory',
  'dist': 'Build Directory'
};

// 获取常见的全局包管理器缓存路径列表
function getGlobalCacheConfig() {
  const home = os.homedir();
  return [
    { id: 'npm', name: 'npm 缓存', path: path.join(home, '.npm'), type: 'Node.js' },
    { id: 'pnpm', name: 'pnpm 存储区', path: path.join(home, 'Library/Share/pnpm'), type: 'Node.js' },
    { id: 'yarn', name: 'Yarn 缓存', path: path.join(home, 'Library/Caches/Yarn'), type: 'Node.js' },
    { id: 'pip', name: 'pip 缓存', path: path.join(home, 'Library/Caches/pip'), type: 'Python' },
    { id: 'pip_cache', name: 'pip 备用缓存', path: path.join(home, '.cache/pip'), type: 'Python' },
    { id: 'cargo_reg', name: 'Cargo 注册表缓存', path: path.join(home, '.cargo/registry'), type: 'Rust' },
    { id: 'cargo_git', name: 'Cargo Git 缓存', path: path.join(home, '.cargo/git'), type: 'Rust' },
    { id: 'go_mod', name: 'Go 模块缓存', path: path.join(home, 'go/pkg/mod'), type: 'Go' },
    { id: 'maven', name: 'Maven 依赖仓库', path: path.join(home, '.m2/repository'), type: 'Java' },
    { id: 'gradle', name: 'Gradle 全局缓存', path: path.join(home, '.gradle/caches'), type: 'Java' },
    { id: 'cocoapods', name: 'CocoaPods 缓存', path: path.join(home, 'Library/Caches/CocoaPods'), type: 'CocoaPods' },
    { id: 'homebrew', name: 'Homebrew 下载缓存', path: path.join(home, 'Library/Caches/Homebrew'), type: 'Homebrew' },
    { id: 'huggingface', name: 'HuggingFace AI模型缓存', path: path.join(home, '.cache/huggingface'), type: 'AI / Python' }
  ];
}

// 递归扫描用户指定的开发目录
async function scanDirectory(dir, onMatch, onProgress, depth = 0, maxDepth = 4) {
  if (depth > maxDepth) return;
  
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    
    // 过滤出子目录
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const name = entry.name;
        const fullPath = path.join(dir, name);
        
        // 忽略隐藏文件夹（除 .venv 外）及常见不需要扫描的大型系统文件夹
        if (name.startsWith('.') && name !== '.venv') {
          continue;
        }

        // 家目录下的常用非开发文件夹防误扫
        if (depth === 0 && [
          'Library', 'Applications', 'System', 'Pictures', 
          'Music', 'Movies', 'Public', 'Desktop', 'Downloads'
        ].includes(name)) {
          continue;
        }

        // 发送当前正在扫描的路径以渲染前台加载提示
        onProgress(fullPath);

        if (TARGET_DIR_MAP[name]) {
          // 命中了需要清理的项目文件夹
          const size = await getDirSize(fullPath);
          const stats = await fs.stat(fullPath);
          
          onMatch({
            path: fullPath,
            name: name,
            type: TARGET_DIR_MAP[name],
            size: size,
            lastModified: stats.mtime
          });
          // 命中该目录后，不需要继续深入此目录扫描了，以大幅缩短扫描时间
          continue;
        }

        // 递归扫描子文件夹
        await scanDirectory(fullPath, onMatch, onProgress, depth + 1, maxDepth);
      }
    }
  } catch (err) {
    // 忽略无法读取的文件夹，继续其它扫描
  }
}

// API: 获取磁盘空间状况
app.get('/api/disk-space', async (req, res) => {
  const disk = await getDiskSpace();
  res.json({ ...disk, homedir: os.homedir() });
});

// API: 获取全局缓存状态
app.get('/api/cache-info', async (req, res) => {
  const configs = getGlobalCacheConfig();
  const results = [];
  
  for (const config of configs) {
    if (existsSync(config.path)) {
      const size = await getDirSize(config.path);
      if (size > 0) {
        results.push({
          ...config,
          size
        });
      }
    }
  }
  res.json(results);
});

// API: 项目依赖扫描，采用 SSE (Server-Sent Events) 实现实时流式响应
app.get('/api/scan', async (req, res) => {
  // 设置 SSE 响应头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  const scanPath = req.query.path || os.homedir();
  
  if (!existsSync(scanPath)) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: '扫描路径不存在' })}\n\n`);
    res.end();
    return;
  }

  res.write(`data: ${JSON.stringify({ type: 'start', path: scanPath })}\n\n`);

  // 开始扫描
  try {
    await scanDirectory(
      scanPath,
      // onMatch
      (matchItem) => {
        res.write(`data: ${JSON.stringify({ type: 'match', item: matchItem })}\n\n`);
      },
      // onProgress
      (scanningPath) => {
        res.write(`data: ${JSON.stringify({ type: 'progress', path: scanningPath })}\n\n`);
      },
      0,
      4 // 限制最大层数 4 层，确保效率与安全性
    );
    res.write(`data: ${JSON.stringify({ type: 'done' })}\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
  } finally {
    res.end();
  }
});

// 安全性检查：避免误删系统核心目录
function isSafeToDelete(targetPath) {
  if (!targetPath || typeof targetPath !== 'string') return false;
  
  const normalized = path.normalize(targetPath).trim();
  const home = os.homedir();
  
  // 严禁删除根目录、用户主目录、应用目录等
  const unsafePaths = [
    '/',
    home,
    path.join(home, 'Desktop'),
    path.join(home, 'Documents'),
    path.join(home, 'Downloads'),
    '/System',
    '/Library',
    '/Applications',
    '/Users'
  ];

  if (unsafePaths.includes(normalized)) {
    return false;
  }

  // 必须是指定的包管理文件夹名，或者是全局缓存配置中的路径
  const baseName = path.basename(normalized);
  const isTargetDir = !!TARGET_DIR_MAP[baseName];
  
  const cachePaths = getGlobalCacheConfig().map(c => c.path);
  const isCacheDir = cachePaths.includes(normalized);

  return isTargetDir || isCacheDir;
}

// API: 执行删除
app.post('/api/clean', async (req, res) => {
  const { paths } = req.body;
  if (!paths || !Array.isArray(paths)) {
    return res.status(400).json({ error: '无效的路径列表' });
  }

  const results = [];
  
  for (const targetPath of paths) {
    if (!isSafeToDelete(targetPath)) {
      results.push({ path: targetPath, success: false, error: '安全策略拒绝删除此路径' });
      continue;
    }

    try {
      await fs.rm(targetPath, { recursive: true, force: true });
      results.push({ path: targetPath, success: true });
    } catch (err) {
      results.push({ path: targetPath, success: false, error: err.message });
    }
  }

  res.json({ results });
});

app.listen(PORT, () => {
  console.log(`Backend server is running on http://localhost:${PORT}`);
});
