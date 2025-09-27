// utils/logManager.ts
import fs from 'fs';
import path from 'path';

export class LogManager {
  private static instance: LogManager;
  private logBuffer: string[] = [];
  private maxBufferSize = 100;
  private logFile = path.join(process.cwd(), 'logs', 'agent.log');
  private errorFile = path.join(process.cwd(), 'logs', 'errors.log');

  private constructor() {
    // Ensure logs directory exists
    const logsDir = path.dirname(this.logFile);
    if (!fs.existsSync(logsDir)) {
      fs.mkdirSync(logsDir, { recursive: true });
    }
  }

  static getInstance(): LogManager {
    if (!LogManager.instance) {
      LogManager.instance = new LogManager();
    }
    return LogManager.instance;
  }

  /**
   * Add log entry to rotating buffer
   */
  addToBuffer(message: string, level: 'info' | 'error' | 'warn' | 'debug' = 'info') {
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] ${level.toUpperCase()}: ${message}`;
    
    this.logBuffer.push(entry);
    
    // Rotate buffer if too large
    if (this.logBuffer.length > this.maxBufferSize) {
      const overflow = this.logBuffer.splice(0, this.logBuffer.length - this.maxBufferSize);
      this.writeToFile(overflow.join('\n'));
    }
  }

  /**
   * Write critical errors to file immediately
   */
  logError(error: string | Error, context?: any) {
    const errorMsg = error instanceof Error ? error.message : error;
    const timestamp = new Date().toISOString();
    const contextStr = context ? ` | Context: ${JSON.stringify(context)}` : '';
    const entry = `[${timestamp}] ERROR: ${errorMsg}${contextStr}\n`;
    
    try {
      fs.appendFileSync(this.errorFile, entry);
    } catch (e) {
      console.error('Failed to write error log:', e);
    }
    
    this.addToBuffer(errorMsg, 'error');
  }

  /**
   * Get recent logs for debugging
   */
  getRecentLogs(count = 20): string[] {
    return this.logBuffer.slice(-count);
  }

  /**
   * Clear log buffer (for memory management)
   */
  clearBuffer() {
    if (this.logBuffer.length > 0) {
      this.writeToFile(this.logBuffer.join('\n'));
      this.logBuffer = [];
    }
  }

  /**
   * Get log summary for terminal output
   */
  getLogSummary(): { errors: number; warnings: number; total: number } {
    const errors = this.logBuffer.filter(log => log.includes('ERROR')).length;
    const warnings = this.logBuffer.filter(log => log.includes('WARN')).length;
    const total = this.logBuffer.length;
    
    return { errors, warnings, total };
  }

  /**
   * Write buffer to file (private method)
   */
  private writeToFile(content: string) {
    try {
      fs.appendFileSync(this.logFile, content + '\n');
    } catch (error) {
      console.error('Failed to write log file:', error);
    }
  }

  /**
   * Cleanup old log files (run on startup)
   */
  cleanup() {
    try {
      const logsDir = path.dirname(this.logFile);
      const files = fs.readdirSync(logsDir);
      const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days in ms
      const now = Date.now();

      files.forEach(file => {
        const filePath = path.join(logsDir, file);
        const stat = fs.statSync(filePath);
        
        if (now - stat.mtime.getTime() > maxAge) {
          fs.unlinkSync(filePath);
        }
      });
    } catch (error) {
      console.error('Log cleanup failed:', error);
    }
  }
}

// Export singleton instance
export const logManager = LogManager.getInstance();

// Auto-cleanup on process exit
process.on('exit', () => {
  logManager.clearBuffer();
});

process.on('SIGINT', () => {
  logManager.clearBuffer();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logManager.clearBuffer();
  process.exit(0);
});