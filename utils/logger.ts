// logger.ts
import pino from 'pino';
import pretty from 'pino-pretty';

// Create a custom stream that limits log size
const createLimitedStream = (maxLines = 100) => {
  let lineCount = 0;
  const lines: string[] = [];
  
  return pretty({
    colorize: true,
    translateTime: 'HH:MM:ss',
    ignore: 'pid,hostname',
    customPrettifiers: {
      // Truncate long messages
      msg: (msg: string) => {
        if (typeof msg === 'string' && msg.length > 200) {
          return msg.substring(0, 200) + '... [truncated]';
        }
        return msg;
      }
    },
    messageFormat: (log, messageKey) => {
      const msg = log[messageKey as keyof typeof log];
      
      // Track line count and rotate if needed
      lineCount++;
      if (lineCount > maxLines) {
        lines.splice(0, lines.length - maxLines + 10); // Keep last 10 + new logs
        lineCount = lines.length;
      }
      
      return `${msg}`;
    }
  });
};

// Configure logger with reduced verbosity
export const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  
  // Custom serializers to limit object size
  serializers: {
    error: (err: Error) => ({
      type: err.constructor.name,
      message: err.message,
      stack: process.env.NODE_ENV === 'development' ? err.stack?.split('\n').slice(0, 3).join('\n') : undefined
    }),
    
    // Limit transaction objects
    transaction: (tx: any) => ({
      id: tx?.transactionId?.toString?.() || 'unknown',
      type: tx?.constructor?.name || 'unknown',
      status: tx?.status || 'unknown'
    }),
    
    // Limit response objects  
    response: (res: any) => {
      if (typeof res === 'object' && res !== null) {
        const limited: any = {};
        Object.keys(res).forEach(key => {
          const value = res[key];
          if (typeof value === 'string' && value.length > 100) {
            limited[key] = value.substring(0, 100) + '...[truncated]';
          } else if (typeof value === 'object' && value !== null) {
            limited[key] = '[object]';
          } else {
            limited[key] = value;
          }
        });
        return limited;
      }
      return res;
    }
  }
}, createLimitedStream(50)); // Limit to 50 lines visible

// Helper functions for common logging patterns
export const logTransaction = (description: string, txId?: string) => {
  logger.info({ txId }, `🔄 ${description}`);
};

export const logSuccess = (message: string, data?: any) => {
  logger.info({ data }, `✅ ${message}`);
};

export const logError = (message: string, error?: any) => {
  logger.error({ 
    error: error instanceof Error ? {
      name: error.name,
      message: error.message
    } : error 
  }, `❌ ${message}`);
};

export const logDebug = (message: string, data?: any) => {
  if (process.env.NODE_ENV === 'development') {
    logger.debug({ data }, `🔍 ${message}`);
  }
};

export const logWarning = (message: string, data?: any) => {
  logger.warn({ data }, `⚠️  ${message}`);
};

// Create a summary logger that only shows essential info
export const summaryLogger = {
  orderCreated: (orderId: string, token: string, amount: string) => {
    logger.info(`📝 Order Created: #${orderId} - ${amount} HBAR → ${token}`);
  },
  
  orderExecuted: (orderId: string, amountOut: string) => {
    logger.info(`🎯 Order Executed: #${orderId} - Received ${amountOut} tokens`);
  },
  
  orderCancelled: (orderId: string) => {
    logger.info(`❌ Order Cancelled: #${orderId}`);
  },
  
  transaction: (type: string, status: 'pending' | 'success' | 'failed', txId?: string) => {
    const statusEmoji = status === 'success' ? '✅' : status === 'failed' ? '❌' : '⏳';
    logger.info(`${statusEmoji} ${type} ${status.toUpperCase()}${txId ? ` (${txId})` : ''}`);
  }
};

export default logger;