// utils/terminalController.ts
import { logManager } from './logManager';

export class TerminalController {
  private static instance: TerminalController;
  private isProcessing = false;
  private lastOutputLength = 0;
  private readonly maxTerminalLines = process.stdout.rows - 5 || 20;

  private constructor() {}

  static getInstance(): TerminalController {
    if (!TerminalController.instance) {
      TerminalController.instance = new TerminalController();
    }
    return TerminalController.instance;
  }

  /**
   * Show processing indicator without cluttering logs
   */
  showProcessing(message = "Processing...") {
    if (this.isProcessing) return;
    
    this.isProcessing = true;
    const spinner = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;

    const interval = setInterval(() => {
      process.stdout.write(`\r${spinner[i]} ${message}`);
      i = (i + 1) % spinner.length;
    }, 100);

    // Store interval for cleanup
    (this as any).processingInterval = interval;
  }

  /**
   * Hide processing indicator
   */
  hideProcessing() {
    if (!this.isProcessing) return;
    
    this.isProcessing = false;
    if ((this as any).processingInterval) {
      clearInterval((this as any).processingInterval);
    }
    
    // Clear the processing line
    process.stdout.write('\r' + ' '.repeat(50) + '\r');
  }

  /**
   * Print message with automatic line management
   */
  print(message: string, type: 'info' | 'success' | 'error' | 'warn' = 'info') {
    this.hideProcessing();

    const icons = {
      info: 'ℹ️ ',
      success: '✅ ',
      error: '❌ ',
      warn: '⚠️  '
    };

    const colors = {
      info: '\x1b[36m',     // Cyan
      success: '\x1b[32m',  // Green  
      error: '\x1b[31m',    // Red
      warn: '\x1b[33m',     // Yellow
      reset: '\x1b[0m'      // Reset
    };

    const coloredMessage = `${colors[type]}${icons[type]}${message}${colors.reset}`;
    console.log(coloredMessage);
    
    // Add to log manager for file logging
    logManager.addToBuffer(message, type);
  }

  /**
   * Print compact status line (overwrites previous)
   */
  printStatus(message: string) {
    process.stdout.write(`\r\x1b[K${message}`); // Clear line and write
  }

  /**
   * Clear screen and show header
   */
  clearAndShowHeader() {
    console.clear();
    
    const header = [
      '🚀 YieldCraft AutoSwap Agent',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '📝 Contract: 0x633da8',
      '💰 Tokens: USDC (6 dec), SAUCE (18 dec)', 
      '⚡ Limits: 0.01 - 180 HBAR per order',
      '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
      '💡 Try: "swap 10 HBAR for USDC at 0.1"',
      '⚙️  Commands: exit, clear, status, logs',
      ''
    ];

    header.forEach(line => console.log(line));
  }

  /**
   * Show compact status summary
   */
  showStatus() {
    const summary = logManager.getLogSummary();
    const memUsage = Math.round(process.memoryUsage().heapUsed / 1024 / 1024);
    
    this.print(`Status: ${summary.total} logs, ${summary.errors} errors, ${summary.warnings} warnings | Memory: ${memUsage}MB`, 'info');
  }

  /**
   * Show recent logs (for debugging)
   */
  showRecentLogs(count = 10) {
    const logs = logManager.getRecentLogs(count);
    
    if (logs.length === 0) {
      this.print('No recent logs', 'info');
      return;
    }

    console.log('\n📋 Recent Logs:');
    console.log('━'.repeat(50));
    
    logs.forEach((log, index) => {
      // Extract timestamp and level for compact display
      const matches = log.match(/\[(.*?)\] (\w+): (.*)/);
      if (matches) {
        const [, timestamp, level, message] = matches;
        const time = new Date(timestamp).toLocaleTimeString();
        const shortMsg = message.length > 60 ? message.substring(0, 60) + '...' : message;
        
        const levelIcon = {
          'INFO': 'ℹ️',
          'ERROR': '❌',
          'WARN': '⚠️',
          'DEBUG': '🔍'
        }[level] || 'ℹ️';
        
        console.log(`${levelIcon} ${time} ${shortMsg}`);
      } else {
        console.log(`  ${log.substring(0, 70)}${log.length > 70 ? '...' : ''}`);
      }
    });
    
    console.log('━'.repeat(50) + '\n');
  }

  /**
   * Format agent response for clean display
   */
  formatResponse(response: string): string {
    return response
      .replace(/```json\n?/g, '')
      .replace(/```\n?/g, '')
      .replace(/\n\s*\n\s*\n/g, '\n\n') // Reduce multiple newlines
      .replace(/^\s+/gm, '') // Remove leading whitespace
      .trim();
  }

  /**
   * Manage terminal scrolling
   */
  private manageScrolling() {
    // Keep terminal from getting too cluttered
    if (this.lastOutputLength > this.maxTerminalLines) {
      console.log('\n' + '─'.repeat(50));
      console.log('📜 Terminal cleaned to prevent overflow');
      console.log('─'.repeat(50) + '\n');
      this.lastOutputLength = 0;
    }
  }
}

// Export singleton
export const terminal = TerminalController.getInstance();