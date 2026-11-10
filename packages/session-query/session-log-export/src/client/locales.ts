/** Locale namespace owned by Session export browser feedback. */
export const NS = 'session-log-download'

/** Simplified-Chinese Session export strings. */
export const zh = {
  'header.action': 'Session 日志',
  'dialog.confirmTitle': '导出未加密的 Session',
  'dialog.plaintextWarning': 'ZIP 包含完整的对话、提示词、工具结果和附件，不会自动隐藏敏感信息。任何获得文件的人都可以读取其中内容。可移植归档保留代理上下文；仅日志归档不能完整恢复代理状态。默认不包含工作区文件。选择工作区 ZIP 会包含所有文件，包括隐藏文件和敏感信息。',
  'dialog.downloadPortable': '下载可移植 ZIP（未加密）',
  'dialog.downloadWorkspace': '下载含工作区的 ZIP（未加密）',
  'dialog.downloadLog': '仅下载日志（未加密）',
  'dialog.preparingTitle': '正在导出 Session',
  'dialog.preparingDescription': '正在准备包含当前 Session、子 Session 和附件的 ZIP 文件。',
  'dialog.successTitle': 'Session 导出已开始下载',
  'dialog.successDescription': '浏览器正在下载 Session ZIP 文件。',
  'dialog.errorTitle': 'Session 导出失败',
  'dialog.close': '关闭',
  'dialog.commandFailed': '无法启动 Session 导出。',
} as const

/** English Session export strings. */
export const en: Record<keyof typeof zh, string> = {
  'header.action': 'Session log',
  'dialog.confirmTitle': 'Export unencrypted Session',
  'dialog.plaintextWarning': 'The ZIP contains complete conversation content, prompts, tool results and attachments without automatic redaction. Anyone with the file can read its contents. A portable archive preserves agent context; a log-only archive cannot fully restore agent state. Workspace files are excluded unless you choose the workspace ZIP. That option includes all files, including hidden files and secrets.',
  'dialog.downloadPortable': 'Download portable ZIP (unencrypted)',
  'dialog.downloadWorkspace': 'Download ZIP with workspace (unencrypted)',
  'dialog.downloadLog': 'Download log only (unencrypted)',
  'dialog.preparingTitle': 'Exporting Session',
  'dialog.preparingDescription': 'Preparing a ZIP containing this Session, its sub-Sessions, and attachments.',
  'dialog.successTitle': 'Session download started',
  'dialog.successDescription': 'The browser is downloading the Session ZIP.',
  'dialog.errorTitle': 'Session export failed',
  'dialog.close': 'Close',
  'dialog.commandFailed': 'Could not start the Session export.',
}

/** Stable locale keys consumed by the shared modal. */
export type SessionLogDownloadKey = keyof typeof zh
