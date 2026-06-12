import React, { useState, useEffect, useRef } from 'react';

// 格式化文件大小为人类可读的字符串
function formatSize(bytes) {
  if (bytes === 0 || isNaN(bytes)) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

export default function App() {
  const [diskSpace, setDiskSpace] = useState({ total: 0, used: 0, available: 0, homedir: '' });
  const [scanPath, setScanPath] = useState('');
  const [isScanning, setIsScanning] = useState(false);
  const [scanningPath, setScanningPath] = useState('');
  const [projects, setProjects] = useState([]);
  const [caches, setCaches] = useState([]);
  const [toasts, setToasts] = useState([]);
  const [sortBy, setSortBy] = useState('size'); // 'size' | 'time'
  const [isLoadingCaches, setIsLoadingCaches] = useState(true);
  const eventSourceRef = useRef(null);

  // 初始化获取系统状态
  useEffect(() => {
    fetchDiskSpace();
    fetchCaches();
  }, []);

  // 获取磁盘空间
  const fetchDiskSpace = async () => {
    try {
      const res = await fetch('/api/disk-space');
      const data = await res.json();
      setDiskSpace(data);
      if (data.homedir && !scanPath) {
        setScanPath(data.homedir);
      }
    } catch (err) {
      showToast('获取磁盘空间数据失败', 'error');
    }
  };

  // 获取全局缓存状态
  const fetchCaches = async () => {
    setIsLoadingCaches(true);
    try {
      const res = await fetch('/api/cache-info');
      const data = await res.json();
      setCaches(data);
    } catch (err) {
      showToast('获取全局缓存数据失败', 'error');
    } finally {
      setIsLoadingCaches(false);
    }
  };

  // 弹窗提示
  const showToast = (message, type = 'success') => {
    const id = Date.now();
    setToasts((prev) => [...prev, { id, message, type }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  };

  // 开始流式扫描
  const handleStartScan = () => {
    if (isScanning) return;
    if (!scanPath.trim()) {
      showToast('请输入有效的扫描路径', 'error');
      return;
    }

    setIsScanning(true);
    setProjects([]);
    setScanningPath('正在初始化扫描...');

    const url = `/api/scan?path=${encodeURIComponent(scanPath)}`;
    const eventSource = new EventSource(url);
    eventSourceRef.current = eventSource;

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === 'start') {
          setScanningPath(`已开始扫描目录：${data.path}`);
        } else if (data.type === 'progress') {
          setScanningPath(data.path);
        } else if (data.type === 'match') {
          setProjects((prev) => {
            // 防止重复添加
            if (prev.some((p) => p.path === data.item.path)) return prev;
            return [...prev, data.item];
          });
        } else if (data.type === 'done') {
          eventSource.close();
          setIsScanning(false);
          setScanningPath('');
          showToast('扫描完成，发现可清理依赖');
          fetchDiskSpace();
        } else if (data.type === 'error') {
          eventSource.close();
          setIsScanning(false);
          setScanningPath('');
          showToast(data.message || '扫描过程中出错', 'error');
        }
      } catch (err) {
        console.error(err);
      }
    };

    eventSource.onerror = () => {
      eventSource.close();
      setIsScanning(false);
      setScanningPath('');
      showToast('与扫描服务断开连接', 'error');
    };
  };

  // 停止扫描
  const handleStopScan = () => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      setIsScanning(false);
      setScanningPath('');
      showToast('扫描已终止', 'error');
    }
  };

  // 清理单个目录（项目级依赖或全局缓存）
  const handleClean = async (pathToDelete, name) => {
    const confirmDelete = window.confirm(`确定要永久删除 ${name} 吗？此操作无法撤销。`);
    if (!confirmDelete) return;

    try {
      const res = await fetch('/api/clean', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: [pathToDelete] }),
      });
      const data = await res.json();
      const result = data.results[0];

      if (result.success) {
        showToast(`已成功清理 ${name}`);
        // 从当前列表中过滤掉已清理项目
        setProjects((prev) => prev.filter((p) => p.path !== pathToDelete));
        setCaches((prev) => prev.filter((c) => c.path !== pathToDelete));
        // 刷新磁盘空间
        fetchDiskSpace();
      } else {
        showToast(result.error || '清理失败', 'error');
      }
    } catch (err) {
      showToast('清理操作失败，请重试', 'error');
    }
  };

  // 一键清理所有扫描出的项目依赖
  const handleCleanAllProjects = async () => {
    if (projects.length === 0) return;
    const confirmDelete = window.confirm(`确定要清理这 ${projects.length} 个项目下的所有编译依赖吗？`);
    if (!confirmDelete) return;

    const paths = projects.map((p) => p.path);
    try {
      const res = await fetch('/api/clean', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths }),
      });
      const data = await res.json();
      
      const successCount = data.results.filter((r) => r.success).length;
      const failCount = data.results.length - successCount;

      if (successCount > 0) {
        showToast(`成功清理 ${successCount} 个目录`);
      }
      if (failCount > 0) {
        showToast(`${failCount} 个目录清理失败（可能存在权限问题）`, 'error');
      }

      // 重新拉取
      setProjects((prev) => prev.filter((p) => !data.results.some((r) => r.success && r.path === p.path)));
      fetchDiskSpace();
    } catch (err) {
      showToast('批量清理操作失败', 'error');
    }
  };

  // 对扫描出的项目依赖进行排序
  const sortedProjects = [...projects].sort((a, b) => {
    if (sortBy === 'size') {
      return b.size - a.size;
    }
    if (sortBy === 'time') {
      return new Date(b.lastModified) - new Date(a.lastModified);
    }
    return 0;
  });

  // 对全局缓存进行大小降序（从大到小）排序
  const sortedCaches = [...caches].sort((a, b) => b.size - a.size);

  // 辅助变量计算
  const projectTotalSize = projects.reduce((sum, p) => sum + p.size, 0);
  const cacheTotalSize = caches.reduce((sum, c) => sum + c.size, 0);
  const cleanableTotal = projectTotalSize + cacheTotalSize;

  // 磁盘使用百分比
  const usedPercent = diskSpace.total > 0 ? (diskSpace.used / diskSpace.total) * 100 : 0;
  // SVG 圆环参数
  const radius = 70;
  const strokeWidth = 14;
  const circumference = 2 * Math.PI * radius;
  const strokeOffset = circumference - (usedPercent / 100) * circumference;

  // 根据依赖类型返回相应的 Badge Class
  const getBadgeClass = (type) => {
    if (type.includes('Node')) return 'badge-node';
    if (type.includes('Python')) return 'badge-python';
    if (type.includes('Rust')) return 'badge-rust';
    if (type.includes('Pods')) return 'badge-cocoapods';
    return 'badge-build';
  };

  return (
    <div className="app-container">
      {/* 头部区域 */}
      <header>
        <div className="brand">
          <div className="brand-logo">C</div>
          <div className="brand-text">
            <h1>CleanMAC</h1>
            <p>Vibe Coding 依赖与缓存智能清理面板</p>
          </div>
        </div>
        <div>
          <button className="btn btn-secondary" onClick={() => { fetchDiskSpace(); fetchCaches(); }}>
            刷新状态
          </button>
        </div>
      </header>

      {/* 仪表盘核心网格 (扁平三列设计，防止参差不齐与倾斜) */}
      <div className="dashboard-grid">
        
        {/* 第一列：控制中心（磁盘状态与扫描配置） */}
        <div className="control-column">
          
          {/* 磁盘空间圆环卡片 */}
          <div className="glass-panel disk-status-panel">
            <div className="radial-chart-container">
              <svg width="180" height="180" style={{ transform: 'rotate(0deg)' }}>
                <defs>
                  <linearGradient id="cyan-purple-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                    <stop offset="0%" stopColor="#00f2fe" />
                    <stop offset="100%" stopColor="#8b5cf6" />
                  </linearGradient>
                </defs>
                <circle className="svg-circle-bg" cx="90" cy="90" r={radius} />
                <circle 
                  className="svg-circle-progress" 
                  cx="90" 
                  cy="90" 
                  r={radius} 
                  strokeDasharray={circumference}
                  strokeDashoffset={strokeOffset}
                />
              </svg>
              <div className="radial-chart-info">
                <span className="radial-chart-percentage">{Math.round(usedPercent)}%</span>
                <span className="radial-chart-label">Mac 磁盘已使用</span>
              </div>
            </div>

            <div className="disk-legend">
              <div className="legend-item">
                <div className="legend-label-group">
                  <span className="legend-dot used" />
                  <span>Mac 整个磁盘已用</span>
                </div>
                <span className="legend-value">{formatSize(diskSpace.used)}</span>
              </div>
              <div className="legend-item">
                <div className="legend-label-group">
                  <span className="legend-dot free" />
                  <span>Mac 磁盘剩余可用</span>
                </div>
                <span className="legend-value">{formatSize(diskSpace.available)}</span>
              </div>
              <div className="legend-item">
                <div className="legend-label-group">
                  <span className="legend-dot cleanable" />
                  <span>可清理总估算</span>
                </div>
                <span className="legend-value" style={{ color: '#fbbf24' }}>
                  {formatSize(cleanableTotal)}
                </span>
              </div>
            </div>
          </div>

          {/* 路径扫描配置卡片 */}
          <div className="glass-panel scan-config-card">
            <h3 className="scan-config-title">开始扫描</h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
              <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>输入扫描的目标主目录：</span>
              <div className="input-group">
                <input 
                  type="text" 
                  className="path-input" 
                  placeholder="/Users/username/Projects"
                  value={scanPath}
                  onChange={(e) => setScanPath(e.target.value)}
                  disabled={isScanning}
                />
              </div>
              <div style={{ display: 'flex', gap: '10px', marginTop: '4px' }}>
                {!isScanning ? (
                  <button className="btn btn-primary" style={{ flex: 1 }} onClick={handleStartScan}>
                    开始扫描
                  </button>
                ) : (
                  <button className="btn btn-primary" style={{ flex: 1, background: 'var(--danger-gradient)', color: '#fff', boxShadow: 'var(--red-glow)' }} onClick={handleStopScan}>
                    停止扫描
                  </button>
                )}
              </div>
            </div>
          </div>

        </div>

        {/* 第二列：项目依赖扫描列表 */}
        <div className="glass-panel projects-card" style={{ gap: '16px' }}>
          <div>
            <h2 style={{ fontSize: '18px', fontWeight: '700' }}>项目冗余包与依赖列表</h2>
            <p style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '2px' }}>
              扫描出深度不超过4层的 node_modules、venv、target 等目录
            </p>
          </div>
          
          {/* 工具栏：排序与一键清理 (独立水平排版，防折行挤压) */}
          {projects.length > 0 && (
            <div style={{ 
              display: 'flex', 
              justifyContent: 'space-between', 
              alignItems: 'center', 
              padding: '12px 16px', 
              background: 'rgba(0, 0, 0, 0.15)', 
              borderRadius: '8px', 
              border: '1px solid rgba(255, 255, 255, 0.03)', 
              marginTop: '4px', 
              marginBottom: '4px',
              gap: '16px',
              flexWrap: 'wrap'
            }}>
              {/* 排序选择区 */}
              <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexShrink: 0 }}>
                <span style={{ fontSize: '13px', color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>排序方式:</span>
                <button 
                  className="btn-clean-single" 
                  style={{ 
                    padding: '5px 12px', 
                    fontSize: '12px', 
                    borderRadius: '6px',
                    background: sortBy === 'size' ? 'var(--primary-gradient)' : 'rgba(255, 255, 255, 0.05)', 
                    color: sortBy === 'size' ? '#000' : 'var(--text-secondary)',
                    border: 'none',
                    fontWeight: '600',
                    cursor: 'pointer',
                    transition: 'var(--transition-smooth)'
                  }}
                  onClick={() => setSortBy('size')}
                >
                  按大小
                </button>
                <button 
                  className="btn-clean-single" 
                  style={{ 
                    padding: '5px 12px', 
                    fontSize: '12px', 
                    borderRadius: '6px',
                    background: sortBy === 'time' ? 'var(--primary-gradient)' : 'rgba(255, 255, 255, 0.05)', 
                    color: sortBy === 'time' ? '#000' : 'var(--text-secondary)',
                    border: 'none',
                    fontWeight: '600',
                    cursor: 'pointer',
                    transition: 'var(--transition-smooth)'
                  }}
                  onClick={() => setSortBy('time')}
                >
                  修改时间
                </button>
              </div>

              {/* 一键清理按钮 */}
              <button 
                className="btn" 
                style={{ 
                  background: 'var(--danger-gradient)', 
                  color: '#fff', 
                  boxShadow: 'var(--red-glow)', 
                  padding: '8px 18px', 
                  fontSize: '13px', 
                  borderRadius: '6px',
                  flexShrink: 0,
                  whiteSpace: 'nowrap'
                }}
                onClick={handleCleanAllProjects}
              >
                一键清理所有项目依赖 ({formatSize(projectTotalSize)})
              </button>
            </div>
          )}

          {projects.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">📂</div>
              <p>{isScanning ? '正在扫描磁盘中，请稍候...' : '暂无数据，请在左侧指定路径并开始扫描'}</p>
            </div>
          ) : (
            <div className="project-list-container">
              {sortedProjects.map((item, index) => (
                <div className="project-item" key={index}>
                  <div className="project-meta">
                    <span className="project-path" title={item.path}>{item.path}</span>
                    <div className="project-sub">
                      <span className={`badge ${getBadgeClass(item.type)}`}>{item.type}</span>
                      <span>修改于: {new Date(item.lastModified).toLocaleDateString()}</span>
                    </div>
                  </div>
                  <div className="project-size-action">
                    <span className="project-size">{formatSize(item.size)}</span>
                    <button 
                      className="btn-clean-single"
                      onClick={() => handleClean(item.path, item.name)}
                    >
                      清理
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* 第三列：全局开发工具与 AI 缓存 */}
        <div className="glass-panel cache-card">
          <div className="card-title-group">
            <h2>全局包管理器与 AI 缓存</h2>
            <p>全局累积的包缓存，通常可以安全清理</p>
          </div>
          
          {isLoadingCaches ? (
            <div className="cache-list">
              {[1, 2, 3, 4].map((n) => (
                <div className="skeleton-item" key={n}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                      <div className="skeleton-line skeleton-name" />
                      <div className="skeleton-line skeleton-size" />
                    </div>
                    <div className="skeleton-line skeleton-path" />
                  </div>
                  <div className="skeleton-line skeleton-btn" style={{ marginLeft: '16px', flexShrink: 0 }} />
                </div>
              ))}
            </div>
          ) : caches.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">⚡</div>
              <p>未发现可清理的全局缓存</p>
            </div>
          ) : (
            <div className="cache-list">
              {sortedCaches.map((cache, index) => (
                <div className="cache-item" key={index} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', gap: '16px' }}>
                  <div className="cache-info" style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: '8px' }}>
                      <span className="cache-name" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', fontWeight: '600' }}>
                        {cache.name}
                      </span>
                      <span className="project-size" style={{ fontSize: '14px', whiteSpace: 'nowrap', fontWeight: '700', color: 'var(--text-primary)' }}>
                        {formatSize(cache.size)}
                      </span>
                    </div>
                    <span className="cache-path" style={{ display: 'block', marginTop: '4px', fontSize: '11px', color: 'var(--text-muted)', fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={cache.path}>
                      {cache.path}
                    </span>
                  </div>
                  <button 
                    className="btn-clean-single"
                    style={{ flexShrink: 0 }}
                    onClick={() => handleClean(cache.path, cache.name)}
                  >
                    清理
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

      </div>

      {/* 实时扫描底部通知条 */}
      {isScanning && scanningPath && (
        <div className="glass-panel scanning-bar">
          <div className="scanning-header">
            <div className="scanning-title">
              <div className="scanning-spinner" />
              <span>系统正在深度扫描开发文件夹...</span>
            </div>
            <span style={{ fontSize: '13px', color: '#00f2fe', fontWeight: 'bold' }}>
              已发现 {projects.length} 个冗余依赖
            </span>
          </div>
          <div className="scanning-path" title={scanningPath}>
            当前扫描：{scanningPath}
          </div>
        </div>
      )}

      {/* 吐司弹窗系统 */}
      <div className="toast-container">
        {toasts.map((toast) => (
          <div className={`toast ${toast.type === 'error' ? 'toast-error' : 'toast-success'}`} key={toast.id}>
            <span>{toast.type === 'error' ? '❌' : '✨'}</span>
            <span>{toast.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
