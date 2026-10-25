const { app, BrowserWindow, shell, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('node:path');

let mainWindow = null;

// Configure autoUpdater
autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

function sendUpdaterStatus(type, data = {}) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('updater:status', { type, ...data });
  }
}

autoUpdater.on('checking-for-update', () => {
  sendUpdaterStatus('checking');
});

autoUpdater.on('update-available', (info) => {
  sendUpdaterStatus('available', { version: info.version });
});

autoUpdater.on('download-progress', (progressObj) => {
  sendUpdaterStatus('progress', {
    percent: Math.round(progressObj.percent),
    transferred: progressObj.transferred,
    total: progressObj.total,
  });
});

autoUpdater.on('update-downloaded', (info) => {
  sendUpdaterStatus('downloaded', { version: info.version });
});

autoUpdater.on('error', (err) => {
  sendUpdaterStatus('error', { message: err?.message || 'Update check failed' });
});

ipcMain.handle('updater:check', async () => {
  if (!app.isPackaged) return { inDev: true };
  try {
    const result = await autoUpdater.checkForUpdates();
    return { updateInfo: result?.updateInfo };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('updater:install', () => {
  autoUpdater.quitAndInstall(false, true);
});

function getIconPath() {
  if (process.platform === 'win32') {
    return path.join(__dirname, '../build/icon.ico');
  }
  return path.join(__dirname, '../build/icon.png');
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 700,
    minHeight: 500,
    title: 'Megahard Whiteboard',
    icon: getIconPath(),
    autoHideMenuBar: true,
    backgroundColor: '#f4f5f7',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.cjs'),
    },
  });

  mainWindow.removeMenu();

  // Open external links (e.g. GitHub releases, sharing guides) in the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http:') || url.startsWith('https:')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  const isDev = !app.isPackaged && (process.argv.includes('--dev') || process.env.NODE_ENV === 'development');

  if (isDev) {
    mainWindow.loadURL(process.env.VITE_DEV_SERVER_URL || 'http://localhost:4173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// Ensure single instance lock so double-clicking .mh or opening the app again focuses the existing window
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    if (app.isPackaged) {
      setTimeout(() => {
        autoUpdater.checkForUpdatesAndNotify().catch(() => {});
      }, 2000);
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
}
