#!/usr/bin/env node

/**
 * Agentic Control Framework (ACF) - MCP Server
 *
 * @author Abhilash Chadhar (FutureAtoms)
 * @description MCP server with 83+ tools for autonomous agent development
 * @version 0.1.1
 *
 * This server provides a JSON-RPC interface for Cursor/Claude to communicate with ACF
 */
const readline = require('readline');
const path = require('path');
const fs = require('fs');
const logger = require('./logger'); // Import our logger

// Import the core functionality
const core = require('./core');
const filesystemTools = require('./filesystem_tools'); // Import filesystem tools

// Import new tools
const terminalTools = require('./tools/terminal_tools');
const searchTools = require('./tools/search_tools');
const editTools = require('./tools/edit_tools');
const enhancedFsTools = require('./tools/enhanced_filesystem_tools');
const browserTools = require('./tools/browser_tools');
const applescriptTools = require('./tools/applescript_tools');
const fileWatcher = require('./file_watcher');

// Create readline interface for JSON-RPC communication
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

// Handle errors in readline
rl.on('error', (err) => {
  logger.error(`Readline interface error: ${err.message}`);
});

// Handle process signals
process.on('SIGINT', () => {
  logger.info('Received SIGINT, shutting down gracefully');
  fileWatcher.stopWatcher();
  process.exit(0);
});

process.on('SIGTERM', () => {
  logger.info('Received SIGTERM, shutting down gracefully');
  fileWatcher.stopWatcher();
  process.exit(0);
});

process.on('uncaughtException', (err) => {
  logger.error(`Uncaught exception: ${err.message}\n${err.stack}`);
  process.exit(1);
});

// Parse command line arguments and set workspace with improved environment variable support
const getArg = (flag) => {
  const index = process.argv.findIndex(arg => arg === flag);
  return index !== -1 && index < process.argv.length - 1 ? process.argv[index + 1] : null;
};

let workspaceRoot = getArg('--workspaceRoot') || 
                     getArg('-w') || 
                     process.env.ACF_PATH ||
                     process.env.WORKSPACE_ROOT || 
                     process.cwd();

// Ensure workspace root is never just '/' which causes issues
if (!workspaceRoot || workspaceRoot === '/') {
  workspaceRoot = process.cwd();
  logger.info(`Invalid workspace root. Using current directory: ${workspaceRoot}`);
}

// Parse allowed directories from environment variable
// Format: dir1:dir2:dir3 (colon-separated paths)
const envAllowedDirs = process.env.ALLOWED_DIRS ? 
  process.env.ALLOWED_DIRS.split(':').filter(Boolean) : 
  [];

// Create an array of allowed directories for filesystem operations
// For security, always include the workspace directory, plus any from environment
const allowedDirectories = [...new Set([workspaceRoot, ...envAllowedDirs])];

// Check if readonly mode is enabled
const readonlyMode = process.env.READONLY_MODE === 'true';
if (readonlyMode) {
  logger.info('Running in read-only mode. Write operations will be blocked.');
}

logger.info(`Starting server with workspace root: ${workspaceRoot}`);
logger.info(`Allowed directories for filesystem operations: ${allowedDirectories.join(', ')}`);

// Initialize file watcher for automatic task table updates
fileWatcher.initializeWatcher(workspaceRoot);

// Counter for generating unique request IDs
let requestCounter = 1;

// Function to send JSON-RPC response
function sendResponse(id, result) {
  const response = {
    jsonrpc: '2.0',
    id: id || 0,  // Ensure id is never undefined, default to 0
    result: result
  };
  // Use logger.output specifically for JSON-RPC responses to stdout
  logger.output(JSON.stringify(response));
}

// Function to send JSON-RPC error
function sendError(id, code, message, data = {}) {
  const response = {
    jsonrpc: '2.0',
    id: id || 0,  // Ensure id is never undefined, default to 0
    error: {
      code: code,
      message: message,
      data: data
    }
  };
  // Use logger.output specifically for JSON-RPC responses to stdout
  logger.output(JSON.stringify(response));
}

// Helper function for the listTasks method
function handleListTasks(requestId, params) {
  try {
    logger.debug(`Handling listTasks with params: ${JSON.stringify(params)}`);

    // Always include format options in params
    const options = {
      ...params
    };

    // Get the tasks data once
    const tasksData = core.readTasks(workspaceRoot);

    // Apply filtering logic directly here instead of calling core.listTasks
    let filteredTasks = [...tasksData.tasks]; // Create a copy

    // Apply status filter if specified
    if (options && options.status) {
      filteredTasks = filteredTasks.filter(task => task.status === options.status);
    }

    // Generate human-readable table with filtered tasks
    const tableRenderer = require('./tableRenderer');
    const humanReadableTable = tableRenderer.generateTaskTable({...tasksData, tasks: filteredTasks}, workspaceRoot);

    // Return the result without calling core.listTasks (which would read tasks again)
    return {
      success: true,
      tasks: filteredTasks,
      taskTable: humanReadableTable
    };
  } catch (error) {
    logger.error(`Error in listTasks: ${error.message}`);
    throw error;
  }
}

// Function to check if an operation is allowed in readonly mode
function checkReadOnlyMode(toolName) {
  if (!readonlyMode) {
    return true; // Not in readonly mode, all operations allowed
  }

  // List of write operations that should be blocked in readonly mode
  const writeOperations = [
    'write_file', 
    'copy_file', 
    'move_file', 
    'delete_file', 
    'create_directory'
  ];

  if (writeOperations.includes(toolName)) {
    return false; // This operation is not allowed in readonly mode
  }

  return true; // Read operation, allowed in readonly mode
}

// Handle incoming lines from stdin (JSON-RPC requests)
rl.on('line', async (line) => {
  let requestId = null; // Store ID for error handling
  try {
    // Log to stderr - stdout is reserved for JSON-RPC responses
    logger.debug(`Received request: ${line}`);
    
    // Parse the request
    const request = JSON.parse(line);
    const { id, method, params } = request;
    requestId = id; // Store the ID
    
    logger.debug(`Parsed request - Method: ${method}, ID: ${id}`);
    
    // Handle different method types
    switch (method) {
      case 'initialize':
        logger.debug('Handling initialize request');

        // Use the latest MCP protocol version
        const supportedProtocolVersions = ['2025-03-26', '2024-11-05'];
        const clientProtocolVersion = params?.protocolVersion;
        let protocolVersion = '2025-03-26'; // Default to latest

        // Check if client requested version is supported
        if (clientProtocolVersion && supportedProtocolVersions.includes(clientProtocolVersion)) {
          protocolVersion = clientProtocolVersion;
        }

        // Respond immediately with proper MCP capabilities
        sendResponse(id, {
          protocolVersion: protocolVersion,
          capabilities: {
            tools: {
              listChanged: true
            },
            logging: {},
            resources: {
              subscribe: false,
              listChanged: false
            }
          },
          serverInfo: {
            name: 'agentic-control-framework',
            title: 'Agentic Control Framework',
            version: '0.1.0'
          }
        });
        break;

      case 'notifications/initialized':
        logger.debug('Handling notifications/initialized');
        // No response needed for notifications
        break;
        
      case 'tools/list':
        // Respond with ACF tools
        logger.debug('Handling tools/list request');
        sendResponse(id, {
          tools: [
            {
              name: 'setWorkspace',
              title: 'Set Workspace',
              description: 'Sets the workspace directory for the task manager.',
              inputSchema: {
                type: 'object',
                properties: {
                  workspacePath: { type: 'string', description: 'The path to the workspace directory.' }
                },
                required: ['workspacePath']
              }
            },
            {
              name: 'initProject',
              title: 'Initialize Project',
              description: 'Initializes the task manager project.',
              inputSchema: {
                type: 'object',
                properties: {
                  projectName: { type: 'string', description: 'Optional name for the project.' },
                  projectDescription: { type: 'string', description: 'Optional goal or description for the project.' },
                  editor: { type: 'string', description: 'Optional editor type for generating specific rule files (e.g., cursor, claude).', enum: ['cursor', 'claude', 'cline', 'void'] }
                }
              }
            },
            {
              name: 'addTask',
              title: 'Add Task',
              description: 'Adds a new task to the task list.',
              inputSchema: {
                type: 'object',
                properties: {
                  title: { type: 'string', description: 'The title of the task.' },
                  description: { type: 'string' },
                  priority: {
                    oneOf: [
                      { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
                      { type: 'number', minimum: 1, maximum: 1000 }
                    ],
                    description: 'Priority as string (low/medium/high/critical) or number (1-1000)',
                    default: 'medium'
                  },
                  dependsOn: { type: 'string' },
                  relatedFiles: { type: 'string' },
                  tests: { type: 'string', description: 'Optional comma-separated string of tests to verify completion.' }
                },
                required: ['title']
              }
            },
            {
              name: 'addSubtask',
              title: 'Add Subtask',
              description: 'Adds a subtask to a specified parent task.',
              inputSchema: {
                type: 'object',
                properties: {
                  parentId: { type: 'number', description: 'The ID of the parent task.' },
                  title: { type: 'string', description: 'The title of the subtask.' },
                  relatedFiles: { type: 'string', description: 'Optional comma-separated string of relevant file paths.' },
                  tests: { type: 'string', description: 'Optional comma-separated string of tests to verify completion.' }
                },
                required: ['parentId', 'title']
              }
            },
            {
              name: 'listTasks',
              title: 'List Tasks',
              description: 'Lists tasks, optionally filtered by status.',
              inputSchema: {
                type: 'object',
                properties: {
                  status: { type: 'string', enum: ['todo', 'inprogress', 'testing', 'done', 'blocked', 'error'], description: 'Optional status to filter by.' },
                  format: { type: 'string', enum: ['json', 'table', 'human'], description: 'Optional output format. "human" provides a readable format with checkboxes.' }
                }
              }
            },
            {
              name: 'updateStatus',
              title: 'Update Status',
              description: 'Updates the status of a task or subtask.',
              inputSchema: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'The ID of the task or subtask (e.g., 1 or 1.1).' },
                  newStatus: { type: 'string', enum: ['todo', 'inprogress', 'testing', 'done', 'blocked', 'error'], description: 'The new status.' },
                  message: { type: 'string', description: 'Optional message to add to the activity log.' }
                },
                required: ['id', 'newStatus']
              }
            },
            {
              name: 'getNextTask',
              title: 'Get Next Task',
              description: 'Gets the next actionable task based on status, dependencies, and priority.',
              inputSchema: {
                type: 'object',
                properties: {}
              },
              annotations: {
                readOnlyHint: true,
                openWorldHint: false
              }
            },
            {
              name: 'updateTask',
              title: 'Update Task',
              description: 'Updates the details of a task (title, description, priority, etc.). Does not update status.',
              inputSchema: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'The ID of the task to update.' },
                  title: { type: 'string' },
                  description: { type: 'string' },
                  priority: {
                    oneOf: [
                      { type: 'string', enum: ['low', 'medium', 'high', 'critical'] },
                      { type: 'number', minimum: 1, maximum: 1000 }
                    ],
                    description: 'Priority as string (low/medium/high/critical) or number (1-1000)'
                  },
                  dependsOn: { type: 'string' },
                  relatedFiles: { type: 'string' },
                  tests: { type: 'string', description: 'Optional comma-separated string of tests to verify completion.' }
                },
                required: ['id']
              }
            },
            {
              name: 'updateSubtask',
              description: 'Updates the details of a subtask (e.g., title).',
              inputSchema: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'The ID of the subtask to update (e.g., "1.1").' },
                  title: { type: 'string', description: 'The new title for the subtask.' },
                  relatedFiles: { type: 'string', description: 'Optional comma-separated string of relevant file paths.' },
                  tests: { type: 'string', description: 'Optional comma-separated string of tests to verify completion.' }
                },
                required: ['id', 'title']
              }
            },
            {
              name: 'removeTask',
              title: 'Remove Task',
              description: 'Removes a task or subtask by its ID.',
              inputSchema: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'The ID of the task or subtask to remove.' }
                },
                required: ['id']
              }
            },
            {
              name: 'getContext',
              description: 'Retrieves detailed context for a specific task or subtask.',
              inputSchema: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'The ID of the task or subtask (e.g., 1 or 1.1).' }
                },
                required: ['id']
              }
            },
            {
              name: 'generateTaskFiles',
              title: 'Generate Task Files',
              description: 'Generates individual Markdown files for each task in the tasks/ directory.',
              inputSchema: {
                type: 'object',
                properties: {}
              },
              annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                openWorldHint: false
              }
            },
            {
              name: 'parsePrd',
              description: 'Parses a Product Requirements Document (PRD) file using the Gemini API to generate tasks.',
              inputSchema: {
                type: 'object',
                properties: {
                  filePath: { type: 'string', description: 'Path to the PRD file to parse.' }
                },
                required: ['filePath']
              }
            },
            {
              name: 'expandTask',
              description: 'Uses the Gemini API to break down a task into subtasks (overwrites existing subtasks).',
              inputSchema: {
                type: 'object',
                properties: {
                  taskId: { type: 'string', description: 'The ID of the task to expand.' }
                },
                required: ['taskId']
              }
            },
            {
              name: 'reviseTasks',
              description: 'Uses the Gemini API to revise future tasks based on a prompt/change, starting from a specific task ID.',
              inputSchema: {
                type: 'object',
                properties: {
                  fromTaskId: { type: 'string', description: 'Task ID from which revision should start.' },
                  prompt: { type: 'string', description: 'User prompt describing the change.' }
                },
                required: ['fromTaskId', 'prompt']
              }
            },
            {
              name: 'generateTaskTable',
              title: 'Generate Task Table',
              description: 'Generates a human-readable Markdown file with task statuses and checkboxes.',
              inputSchema: {
                type: 'object',
                properties: {}
              },
              annotations: {
                readOnlyHint: false,
                destructiveHint: false,
                openWorldHint: false
              }
            },
            // Priority management tools
            {
              name: 'recalculatePriorities',
              description: 'Recalculate all task priorities using advanced algorithms including dependency boosts and distribution optimization.',
              inputSchema: {
                type: 'object',
                properties: {
                  applyDependencyBoosts: { type: 'boolean', description: 'Apply dependency-based priority boosts', default: true },
                  applyTimeDecay: { type: 'boolean', description: 'Apply time-based priority decay', default: false },
                  optimizeDistribution: { type: 'boolean', description: 'Optimize priority distribution', default: true }
                }
              }
            },
            {
              name: 'getPriorityStatistics',
              description: 'Get priority statistics for all tasks including distribution and utilization.',
              inputSchema: {
                type: 'object',
                properties: {
                  random_string: { type: 'string', description: 'Dummy parameter for no-parameter tools' }
                },
                required: ['random_string']
              }
            },
            {
              name: 'getDependencyAnalysis',
              description: 'Get comprehensive dependency analysis including critical paths, blocking tasks, and circular dependencies.',
              inputSchema: {
                type: 'object',
                properties: {
                  random_string: { type: 'string', description: 'Dummy parameter for no-parameter tools' }
                },
                required: ['random_string']
              }
            },
            {
              name: 'configureTimeDecay',
              description: 'Configure time-based priority decay settings with multiple decay models.',
              inputSchema: {
                type: 'object',
                properties: {
                  enabled: { type: 'boolean', description: 'Enable or disable time decay' },
                  model: {
                    type: 'string',
                    enum: ['linear', 'exponential', 'logarithmic', 'sigmoid', 'adaptive'],
                    description: 'Decay model to use'
                  },
                  rate: { type: 'number', minimum: 0.001, maximum: 0.2, description: 'Decay rate (0.001-0.2)' },
                  threshold: { type: 'integer', minimum: 1, maximum: 365, description: 'Days before decay starts' },
                  maxBoost: { type: 'integer', minimum: 0, maximum: 500, description: 'Maximum aging boost for critical tasks' },
                  priorityWeight: { type: 'boolean', description: 'Enable priority-weighted decay rates' }
                }
              }
            },
            {
              name: 'configureEffortWeighting',
              description: 'Configure effort-weighted priority scoring based on task complexity, impact, and urgency.',
              inputSchema: {
                type: 'object',
                properties: {
                  enabled: { type: 'boolean', description: 'Enable or disable effort weighting' },
                  scoreWeight: { type: 'number', minimum: 0, maximum: 1, description: 'Weight of effort score in priority calculation' },
                  complexityWeight: { type: 'number', minimum: 0, maximum: 1, description: 'Weight of complexity in effort calculation' },
                  impactWeight: { type: 'number', minimum: 0, maximum: 1, description: 'Weight of impact in effort calculation' },
                  urgencyWeight: { type: 'number', minimum: 0, maximum: 1, description: 'Weight of urgency in effort calculation' },
                  decayRate: { type: 'number', minimum: 0, maximum: 0.1, description: 'Effort score decay rate over time' },
                  boostThreshold: { type: 'number', minimum: 0, maximum: 1, description: 'Effort score threshold for priority boost' }
                }
              }
            },
            {
              name: 'getAdvancedAlgorithmConfig',
              description: 'Get current configuration for all advanced priority algorithms including time decay and effort weighting.',
              inputSchema: {
                type: 'object',
                properties: {
                  random_string: { type: 'string', description: 'Dummy parameter for no-parameter tools' }
                },
                required: ['random_string']
              }
            },
            {
              name: 'initializeFileWatcher',
              description: 'Initialize automatic file synchronization watcher for tasks.json changes.',
              inputSchema: {
                type: 'object',
                properties: {
                  debounceDelay: { type: 'integer', minimum: 100, maximum: 5000, description: 'Debounce delay in milliseconds' },
                  maxQueueSize: { type: 'integer', minimum: 1, maximum: 100, description: 'Maximum change queue size' },
                  enableTaskFiles: { type: 'boolean', description: 'Enable individual task file generation' },
                  enableTableSync: { type: 'boolean', description: 'Enable task table synchronization' },
                  enablePriorityRecalc: { type: 'boolean', description: 'Enable automatic priority recalculation' }
                }
              }
            },
            {
              name: 'stopFileWatcher',
              description: 'Stop the automatic file synchronization watcher.',
              inputSchema: {
                type: 'object',
                properties: {
                  random_string: { type: 'string', description: 'Dummy parameter for no-parameter tools' }
                },
                required: ['random_string']
              }
            },
            {
              name: 'getFileWatcherStatus',
              description: 'Get current file watcher status, statistics, and configuration.',
              inputSchema: {
                type: 'object',
                properties: {
                  random_string: { type: 'string', description: 'Dummy parameter for no-parameter tools' }
                },
                required: ['random_string']
              }
            },
            {
              name: 'forceSyncTaskFiles',
              description: 'Force immediate synchronization of all task-related files.',
              inputSchema: {
                type: 'object',
                properties: {
                  random_string: { type: 'string', description: 'Dummy parameter for no-parameter tools' }
                },
                required: ['random_string']
              }
            },
            {
              name: 'getPriorityTemplates',
              description: 'Get all available priority templates for common task types.',
              inputSchema: {
                type: 'object',
                properties: {
                  random_string: { type: 'string', description: 'Dummy parameter for no-parameter tools' }
                },
                required: ['random_string']
              }
            },
            {
              name: 'suggestPriorityTemplate',
              description: 'Suggest the best priority template for a task based on title and description.',
              inputSchema: {
                type: 'object',
                properties: {
                  title: { type: 'string', description: 'Task title' },
                  description: { type: 'string', description: 'Task description' }
                },
                required: ['title']
              }
            },
            {
              name: 'calculatePriorityFromTemplate',
              description: 'Calculate priority for a task using a specific template.',
              inputSchema: {
                type: 'object',
                properties: {
                  templateName: { type: 'string', description: 'Name of the template to use' },
                  title: { type: 'string', description: 'Task title' },
                  description: { type: 'string', description: 'Task description' },
                  tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' }
                },
                required: ['templateName', 'title']
              }
            },
            {
              name: 'addTaskWithTemplate',
              description: 'Add a new task using a priority template for automatic priority calculation.',
              inputSchema: {
                type: 'object',
                properties: {
                  title: { type: 'string', description: 'Task title' },
                  description: { type: 'string', description: 'Task description' },
                  templateName: { type: 'string', description: 'Name of the template to use' },
                  tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags' },
                  dependsOn: { type: 'array', items: { type: 'integer' }, description: 'Task IDs this task depends on' },
                  relatedFiles: { type: 'array', items: { type: 'string' }, description: 'Related file paths' }
                },
                required: ['title', 'templateName']
              }
            },
            {
              name: 'bumpTaskPriority',
              description: 'Increase task priority by a specified amount.',
              inputSchema: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'The ID of the task to bump' },
                  amount: { type: 'number', description: 'Amount to increase priority by', default: 50, minimum: 1, maximum: 999 }
                },
                required: ['id']
              }
            },
            {
              name: 'deferTaskPriority',
              description: 'Decrease task priority by a specified amount.',
              inputSchema: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'The ID of the task to defer' },
                  amount: { type: 'number', description: 'Amount to decrease priority by', default: 50, minimum: 1, maximum: 999 }
                },
                required: ['id']
              }
            },
            {
              name: 'prioritizeTask',
              description: 'Set task to high priority (800-900 range).',
              inputSchema: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'The ID of the task to prioritize' },
                  priority: { type: 'number', description: 'Specific priority value (800-900)', default: 850, minimum: 800, maximum: 900 }
                },
                required: ['id']
              }
            },
            {
              name: 'deprioritizeTask',
              description: 'Set task to low priority (100-400 range).',
              inputSchema: {
                type: 'object',
                properties: {
                  id: { type: 'string', description: 'The ID of the task to deprioritize' },
                  priority: { type: 'number', description: 'Specific priority value (100-400)', default: 300, minimum: 100, maximum: 400 }
                },
                required: ['id']
              }
            },
            // Filesystem tools
            {
              name: 'read_file',
              title: 'Read File',
              description: 'Read the complete contents of a file from the file system or from a URL.',
              inputSchema: {
                type: 'object',
                properties: {
                  path: { type: 'string', description: 'Path to the file to read or URL to fetch' },
                  isUrl: { type: 'boolean', description: 'Whether the path is a URL (optional, auto-detected if starts with http:// or https://)' },
                  timeout: { type: 'number', description: 'Timeout for URL requests in milliseconds (optional, default: 30000)' }
                },
                required: ['path']
              }
            },
            {
              name: 'read_multiple_files',
              description: 'Read the contents of multiple files in a single operation.',
              inputSchema: {
                type: 'object',
                properties: {
                  paths: { 
                    type: 'array', 
                    items: { type: 'string' },
                    description: 'List of file paths to read' 
                  }
                },
                required: ['paths']
              }
            },
            {
              name: 'write_file',
              title: 'Write File',
              description: 'Create a new file or overwrite an existing file with new content.' + (readonlyMode ? ' (DISABLED IN READ-ONLY MODE)' : ''),
              inputSchema: {
                type: 'object',
                properties: {
                  path: { type: 'string', description: 'Path where to write the file' },
                  content: { type: 'string', description: 'Content to write to the file' }
                },
                required: ['path', 'content']
              }
            },
            {
              name: 'copy_file',
              description: 'Copy files and directories.' + (readonlyMode ? ' (DISABLED IN READ-ONLY MODE)' : ''),
              inputSchema: {
                type: 'object',
                properties: {
                  source: { type: 'string', description: 'Source path of the file or directory' },
                  destination: { type: 'string', description: 'Destination path' }
                },
                required: ['source', 'destination']
              }
            },
            {
              name: 'move_file',
              description: 'Move or rename files and directories.' + (readonlyMode ? ' (DISABLED IN READ-ONLY MODE)' : ''),
              inputSchema: {
                type: 'object',
                properties: {
                  source: { type: 'string', description: 'Source path of the file or directory' },
                  destination: { type: 'string', description: 'Destination path' }
                },
                required: ['source', 'destination']
              }
            },
            {
              name: 'delete_file',
              description: 'Delete a file or directory from the file system.' + (readonlyMode ? ' (DISABLED IN READ-ONLY MODE)' : ''),
              inputSchema: {
                type: 'object',
                properties: {
                  path: { type: 'string', description: 'Path to the file or directory to delete' },
                  recursive: { type: 'boolean', description: 'Whether to recursively delete directories (default: false)' }
                },
                required: ['path']
              }
            },
            {
              name: 'list_directory',
              description: 'Get a detailed listing of all files and directories in a specified path.',
              inputSchema: {
                type: 'object',
                properties: {
                  path: { type: 'string', description: 'Path of the directory to list' }
                },
                required: ['path']
              }
            },
            {
              name: 'create_directory',
              description: 'Create a new directory or ensure a directory exists.' + (readonlyMode ? ' (DISABLED IN READ-ONLY MODE)' : ''),
              inputSchema: {
                type: 'object',
                properties: {
                  path: { type: 'string', description: 'Path of the directory to create' }
                },
                required: ['path']
              }
            },
            {
              name: 'tree',
              description: 'Returns a hierarchical JSON representation of a directory structure.',
              inputSchema: {
                type: 'object',
                properties: {
                  path: { type: 'string', description: 'Path of the directory to traverse' },
                  depth: { type: 'number', description: 'Maximum depth to traverse (default: 3)' },
                  follow_symlinks: { type: 'boolean', description: 'Whether to follow symbolic links (default: false)' }
                },
                required: ['path']
              }
            },
            {
              name: 'search_files',
              description: 'Recursively search for files and directories matching a pattern.',
              inputSchema: {
                type: 'object',
                properties: {
                  path: { type: 'string', description: 'Starting path for the search' },
                  pattern: { type: 'string', description: 'Search pattern to match against file names' }
                },
                required: ['path', 'pattern']
              }
            },
            {
              name: 'get_file_info',
              description: 'Retrieve detailed metadata about a file or directory.',
              inputSchema: {
                type: 'object',
                properties: {
                  path: { type: 'string', description: 'Path to the file or directory' }
                },
                required: ['path']
              }
            },
            {
              name: 'list_allowed_directories',
              title: 'List Allowed Directories',
              description: 'Returns the list of directories that this server is allowed to access.',
              inputSchema: {
                type: 'object',
                properties: {}
              },
              annotations: {
                readOnlyHint: true,
                openWorldHint: false
              }
            },
            {
              name: 'get_filesystem_status',
              description: 'Returns the current status of filesystem operations, including read-only mode and allowed directories.',
              inputSchema: {
                type: 'object',
                properties: {
                  random_string: { type: 'string', description: 'Dummy parameter for no-parameter tools' }
                },
                required: ['random_string']
              }
            },
            
            // Desktop Commander MCP Tools
            {
              name: 'get_config',
              description: 'Get the complete server configuration as JSON',
              inputSchema: {
                type: 'object',
                properties: {
                  random_string: { type: 'string', description: 'Dummy parameter for no-parameter tools' }
                },
                required: ['random_string']
              }
            },
            {
              name: 'set_config_value',
              description: 'Set a specific configuration value by key',
              inputSchema: {
                type: 'object',
                properties: {
                  key: { type: 'string', description: 'Configuration key to set' },
                  value: { description: 'Value to set for the configuration key' }
                },
                required: ['key', 'value']
              }
            },
            {
              name: 'execute_command',
              title: 'Execute Command',
              description: 'Execute a terminal command with timeout',
              inputSchema: {
                type: 'object',
                properties: {
                  command: { type: 'string', description: 'Command to execute' },
                  shell: { type: 'string', description: 'Shell to use (optional)' },
                  timeout_ms: { type: 'number', description: 'Timeout in milliseconds (optional)' }
                },
                required: ['command']
              }
            },
            {
              name: 'read_output',
              description: 'Read new output from a running terminal session',
              inputSchema: {
                type: 'object',
                properties: {
                  pid: { type: 'number', description: 'Process ID of the running command' }
                },
                required: ['pid']
              }
            },
            {
              name: 'force_terminate',
              description: 'Force terminate a running terminal session',
              inputSchema: {
                type: 'object',
                properties: {
                  pid: { type: 'number', description: 'Process ID to terminate' }
                },
                required: ['pid']
              }
            },
            {
              name: 'list_sessions',
              description: 'List all active terminal sessions',
              inputSchema: {
                type: 'object',
                properties: {
                  random_string: { type: 'string', description: 'Dummy parameter for no-parameter tools' }
                },
                required: ['random_string']
              }
            },
            {
              name: 'list_processes',
              description: 'List all running processes',
              inputSchema: {
                type: 'object',
                properties: {
                  random_string: { type: 'string', description: 'Dummy parameter for no-parameter tools' }
                },
                required: ['random_string']
              }
            },
            {
              name: 'kill_process',
              description: 'Terminate a running process by PID',
              inputSchema: {
                type: 'object',
                properties: {
                  pid: { type: 'number', description: 'Process ID to kill' }
                },
                required: ['pid']
              }
            },
            {
              name: 'search_code',
              description: 'Search for text/code patterns within file contents using ripgrep',
              inputSchema: {
                type: 'object',
                properties: {
                  path: { type: 'string', description: 'Starting path for the search' },
                  pattern: { type: 'string', description: 'Search pattern' },
                  ignoreCase: { type: 'boolean', description: 'Case insensitive search (default: true)' },
                  filePattern: { type: 'string', description: 'File pattern filter (optional)' },
                  contextLines: { type: 'number', description: 'Number of context lines (optional)' },
                  includeHidden: { type: 'boolean', description: 'Include hidden files (optional)' },
                  maxResults: { type: 'number', description: 'Maximum results (default: 100)' },
                  timeoutMs: { type: 'number', description: 'Timeout in milliseconds (optional)' }
                },
                required: ['path', 'pattern']
              }
            },
            {
              name: 'edit_block',
              description: 'Apply surgical text replacements to files',
              inputSchema: {
                type: 'object',
                properties: {
                  file_path: { type: 'string', description: 'Path to the file to edit' },
                  old_string: { type: 'string', description: 'Text to replace' },
                  new_string: { type: 'string', description: 'Replacement text' },
                  expected_replacements: { type: 'number', description: 'Expected number of replacements (default: 1)' }
                },
                required: ['file_path', 'old_string', 'new_string']
              }
            },
            
            // Playwright MCP Browser Tools
            {
              name: 'browser_navigate',
              description: 'Navigate to a URL',
              inputSchema: {
                type: 'object',
                properties: {
                  url: { type: 'string', description: 'The URL to navigate to' }
                },
                required: ['url']
              }
            },
            {
              name: 'browser_navigate_back',
              description: 'Go back to the previous page',
              inputSchema: {
                type: 'object',
                properties: {
                  random_string: { type: 'string', description: 'Dummy parameter for no-parameter tools' }
                },
                required: ['random_string']
              }
            },
            {
              name: 'browser_navigate_forward',
              description: 'Go forward to the next page',
              inputSchema: {
                type: 'object',
                properties: {
                  random_string: { type: 'string', description: 'Dummy parameter for no-parameter tools' }
                },
                required: ['random_string']
              }
            },
            {
              name: 'browser_click',
              description: 'Perform click on a web page',
              inputSchema: {
                type: 'object',
                properties: {
                  element: { type: 'string', description: 'Human-readable element description' },
                  ref: { type: 'string', description: 'Exact target element reference from the page snapshot' }
                },
                required: ['element', 'ref']
              }
            },
            {
              name: 'browser_type',
              description: 'Type text into editable element',
              inputSchema: {
                type: 'object',
                properties: {
                  element: { type: 'string', description: 'Human-readable element description' },
                  ref: { type: 'string', description: 'Exact target element reference' },
                  text: { type: 'string', description: 'Text to type into the element' },
                  submit: { type: 'boolean', description: 'Whether to submit entered text (press Enter after)' },
                  slowly: { type: 'boolean', description: 'Whether to type one character at a time' }
                },
                required: ['element', 'ref', 'text']
              }
            },
            {
              name: 'browser_hover',
              description: 'Hover over element on page',
              inputSchema: {
                type: 'object',
                properties: {
                  element: { type: 'string', description: 'Human-readable element description' },
                  ref: { type: 'string', description: 'Exact target element reference' }
                },
                required: ['element', 'ref']
              }
            },
            {
              name: 'browser_drag',
              description: 'Perform drag and drop between two elements',
              inputSchema: {
                type: 'object',
                properties: {
                  startElement: { type: 'string', description: 'Human-readable source element description' },
                  startRef: { type: 'string', description: 'Exact source element reference' },
                  endElement: { type: 'string', description: 'Human-readable target element description' },
                  endRef: { type: 'string', description: 'Exact target element reference' }
                },
                required: ['startElement', 'startRef', 'endElement', 'endRef']
              }
            },
            {
              name: 'browser_select_option',
              description: 'Select an option in a dropdown',
              inputSchema: {
                type: 'object',
                properties: {
                  element: { type: 'string', description: 'Human-readable element description' },
                  ref: { type: 'string', description: 'Exact target element reference' },
                  values: { type: 'array', items: { type: 'string' }, description: 'Array of values to select' }
                },
                required: ['element', 'ref', 'values']
              }
            },
            {
              name: 'browser_press_key',
              description: 'Press a key on the keyboard',
              inputSchema: {
                type: 'object',
                properties: {
                  key: { type: 'string', description: 'Name of the key to press (e.g., ArrowLeft, a)' }
                },
                required: ['key']
              }
            },
            {
              name: 'browser_take_screenshot',
              description: 'Take a screenshot of the current page',
              inputSchema: {
                type: 'object',
                properties: {
                  element: { type: 'string', description: 'Human-readable element description (optional)' },
                  ref: { type: 'string', description: 'Element reference for element screenshot (optional)' },
                  filename: { type: 'string', description: 'File name to save the screenshot (optional)' },
                  raw: { type: 'boolean', description: 'Whether to return PNG format (default: false for JPEG)' }
                }
              }
            },
            {
              name: 'browser_snapshot',
              description: 'Capture accessibility snapshot of the current page',
              inputSchema: {
                type: 'object',
                properties: {
                  random_string: { type: 'string', description: 'Dummy parameter for no-parameter tools' }
                },
                required: ['random_string']
              }
            },
            {
              name: 'browser_pdf_save',
              description: 'Save page as PDF',
              inputSchema: {
                type: 'object',
                properties: {
                  filename: { type: 'string', description: 'File name to save the PDF (optional)' }
                }
              }
            },
            {
              name: 'browser_console_messages',
              description: 'Returns all console messages',
              inputSchema: {
                type: 'object',
                properties: {
                  random_string: { type: 'string', description: 'Dummy parameter for no-parameter tools' }
                },
                required: ['random_string']
              }
            },
            {
              name: 'browser_file_upload',
              description: 'Upload one or multiple files',
              inputSchema: {
                type: 'object',
                properties: {
                  paths: { type: 'array', items: { type: 'string' }, description: 'Array of file paths to upload' }
                },
                required: ['paths']
              }
            },
            {
              name: 'browser_wait',
              description: 'Wait for a specified time in seconds',
              inputSchema: {
                type: 'object',
                properties: {
                  time: { type: 'number', description: 'Time to wait in seconds (max 10)' }
                },
                required: ['time']
              }
            },
            {
              name: 'browser_wait_for',
              description: 'Wait for text to appear or disappear or a specified time',
              inputSchema: {
                type: 'object',
                properties: {
                  text: { type: 'string', description: 'Text to wait for to appear' },
                  textGone: { type: 'string', description: 'Text to wait for to disappear' },
                  time: { type: 'number', description: 'Time to wait in seconds' }
                }
              }
            },
            {
              name: 'browser_resize',
              description: 'Resize the browser window',
              inputSchema: {
                type: 'object',
                properties: {
                  width: { type: 'number', description: 'Width of the browser window' },
                  height: { type: 'number', description: 'Height of the browser window' }
                },
                required: ['width', 'height']
              }
            },
            {
              name: 'browser_handle_dialog',
              description: 'Handle a dialog',
              inputSchema: {
                type: 'object',
                properties: {
                  accept: { type: 'boolean', description: 'Whether to accept the dialog' },
                  promptText: { type: 'string', description: 'Text for prompt dialogs (optional)' }
                },
                required: ['accept']
              }
            },
            {
              name: 'browser_close',
              description: 'Close the page',
              inputSchema: {
                type: 'object',
                properties: {
                  random_string: { type: 'string', description: 'Dummy parameter for no-parameter tools' }
                },
                required: ['random_string']
              }
            },
            {
              name: 'browser_install',
              description: 'Install the browser specified in the config',
              inputSchema: {
                type: 'object',
                properties: {
                  random_string: { type: 'string', description: 'Dummy parameter for no-parameter tools' }
                },
                required: ['random_string']
              }
            },
            {
              name: 'browser_tab_list',
              description: 'List browser tabs',
              inputSchema: {
                type: 'object',
                properties: {
                  random_string: { type: 'string', description: 'Dummy parameter for no-parameter tools' }
                },
                required: ['random_string']
              }
            },
            {
              name: 'browser_tab_new',
              description: 'Open a new tab',
              inputSchema: {
                type: 'object',
                properties: {
                  url: { type: 'string', description: 'URL to navigate to in the new tab (optional)' }
                }
              }
            },
            {
              name: 'browser_tab_select',
              description: 'Select a tab by index',
              inputSchema: {
                type: 'object',
                properties: {
                  index: { type: 'number', description: 'The index of the tab to select' }
                },
                required: ['index']
              }
            },
            {
              name: 'browser_tab_close',
              description: 'Close a tab',
              inputSchema: {
                type: 'object',
                properties: {
                  index: { type: 'number', description: 'Index of the tab to close (optional, closes current if not provided)' }
                }
              }
            },
            {
              name: 'browser_network_requests',
              description: 'Returns all network requests since loading the page',
              inputSchema: {
                type: 'object',
                properties: {
                  random_string: { type: 'string', description: 'Dummy parameter for no-parameter tools' }
                },
                required: ['random_string']
              }
            },
            
            // AppleScript Tools
            {
              name: 'applescript_execute',
              description: 'Run AppleScript code to interact with Mac applications and system features. This tool can access and manipulate data in Notes, Calendar, Contacts, Messages, Mail, Finder, Safari, and other Apple applications. Common use cases include but not limited to: - Retrieve or create notes in Apple Notes - Access or add calendar events and appointments - List contacts or modify contact details - Search for and organize files using Spotlight or Finder - Get system information like battery status, disk space, or network details - Read or organize browser bookmarks or history - Access or send emails, messages, or other communications - Read, write, or manage file contents - Execute shell commands and capture the output',
              inputSchema: {
                type: 'object',
                properties: {
                  code_snippet: { type: 'string', description: 'Multi-line appleScript code to execute' },
                  timeout: { type: 'number', description: 'Command execution timeout in seconds (default: 60)' }
                },
                required: ['code_snippet']
              }
            }
          ]
        });
        break;
      
      case 'tools/call':
      case 'tools/run':
        logger.debug(`Processing tool request: ${JSON.stringify(params)}`);
        
        // Extract the parameters we need
        const toolName = method === 'tools/call' ? params.name : params.tool; // Adjust based on MCP version
        const args = method === 'tools/call' 
          ? (params.arguments || params.parameters || {}) // Try both argument formats with fallback
          : (params.args || {});
        
        logger.debug(`Invoking tool: ${toolName} with args: ${JSON.stringify(args)}`);
        
        try {
          // Handle the specific tool requests
          let responseData;
          
          switch (toolName) {
            case 'setWorkspace':
              if (args.workspacePath && fs.existsSync(args.workspacePath)) {
                workspaceRoot = args.workspacePath;
                // Update allowed directories when workspace changes
                const index = allowedDirectories.indexOf(allowedDirectories[0]);
                if (index !== -1) {
                  allowedDirectories[index] = workspaceRoot;
                } else {
                  allowedDirectories.unshift(workspaceRoot);
                }
                logger.info(`Workspace root set to: ${workspaceRoot}`);
                logger.info(`Allowed directories updated: ${allowedDirectories.join(', ')}`);

                // Reinitialize file watcher for the new workspace
                fileWatcher.initializeWatcher(workspaceRoot);

                responseData = { success: true, message: `Workspace set to ${workspaceRoot}` };
              } else {
                const path = args.workspacePath ? args.workspacePath : 'undefined';
                logger.error(`Invalid workspace path: ${path}`);
                responseData = { success: false, message: `Invalid or non-existent workspace path: ${path}` };
              }
              break;
              
            case 'initProject':
              responseData = core.initProject(workspaceRoot, {
                projectName: args.projectName || 'Untitled Project',
                projectDescription: args.projectDescription || '',
                editor: args.editor
              });
              break;
              
            case 'addTask':
              // Check required parameters
              if (!args || !args.title) {
                logger.error('Missing required parameter: title for addTask');
                sendError(id, -32602, 'Missing required parameter: title for addTask');
                return;
              }
              
              responseData = core.addTask(workspaceRoot, {
                title: args.title,
                description: args.description || '',
                priority: args.priority || 'medium',
                dependsOn: args.dependsOn || '',
                relatedFiles: args.relatedFiles || '',
                tests: args.tests || ''
              });
              break;
              
            case 'addSubtask':
              // Check required parameters
              if (!args || !args.parentId || !args.title) {
                logger.error('Missing required parameters for addSubtask: parentId and/or title');
                sendError(id, -32602, 'Missing required parameters for addSubtask: parentId and/or title');
                return;
              }
              
              responseData = core.addSubtask(workspaceRoot, 
                args.parentId, 
                {
                  title: args.title,
                  relatedFiles: args.relatedFiles || '',
                  tests: args.tests || ''
                }
              );
              break;
              
            case 'listTasks':
              const listTasksResponse = handleListTasks(id, params);
              responseData = listTasksResponse;
              break;
              
            case 'updateStatus':
              // Check required parameters
              if (!args || !args.id || !args.newStatus) {
                logger.error('Missing required parameters for updateStatus: id and/or newStatus');
                sendError(id, -32602, 'Missing required parameters for updateStatus: id and/or newStatus');
                return;
              }

              try {
                // Read tasks once and handle both relatedFiles update and status update
                const tasksData = core.readTasks(workspaceRoot);
                const { task, subtask, parentTask } = core.findTask(tasksData, args.id);
                const item = task || subtask;

                if (!item) {
                  responseData = { success: false, message: `Task or subtask with ID ${args.id} not found.` };
                  break;
                }

                // If relatedFiles are provided, update them directly
                if (args.newStatus === 'done' && args.relatedFiles) {
                  const parseCommaSeparated = (str) => (typeof str === 'string' ? str.split(',').map(s => s.trim()).filter(Boolean) : []);
                  item.relatedFiles = parseCommaSeparated(args.relatedFiles);

                  // Add activity log entry for related files update
                  if (!item.activityLog) item.activityLog = [];
                  item.activityLog.push({
                    timestamp: new Date().toISOString(),
                    type: 'log',
                    message: 'Related files updated.'
                  });
                }

                // Perform status validation logic directly here
                if (['inprogress', 'testing'].includes(args.newStatus.toLowerCase())) {
                  if (item.dependsOn && item.dependsOn.length > 0) {
                    const dependenciesMet = item.dependsOn.every(depId => {
                      const dependency = tasksData.tasks.find(t => t.id === depId);
                      return dependency && dependency.status === 'done';
                    });

                    if (!dependenciesMet) {
                      responseData = { success: false, message: `Cannot start task ${args.id}. It has unmet dependencies.` };
                      break;
                    }
                  }
                }

                // Prevent marking a task as done if it has incomplete subtasks
                if (args.newStatus.toLowerCase() === 'done' && item.subtasks && item.subtasks.some(s => s.status !== 'done')) {
                  responseData = { success: false, message: `Cannot mark task ${args.id} as done. All its subtasks must be completed first.` };
                  break;
                }

                // Update status directly
                const oldStatus = item.status;
                item.status = args.newStatus.toLowerCase();

                const logMessage = args.message
                  ? `Status changed from "${oldStatus}" to "${args.newStatus}". Message: ${args.message}`
                  : `Status changed from "${oldStatus}" to "${args.newStatus}"`;

                // Add activity log entry for status change
                if (!item.activityLog) item.activityLog = [];
                item.activityLog.push({
                  timestamp: new Date().toISOString(),
                  type: 'log',
                  message: logMessage
                });

                // Update timestamps
                item.updatedAt = new Date().toISOString();
                if (parentTask) {
                  parentTask.updatedAt = new Date().toISOString();
                }

                // Handle testing subtasks generation if needed
                if (item && !item.id.toString().includes('.') && args.newStatus.toLowerCase() === 'testing') {
                  const testingSubtasks = [
                    { title: `Write unit and integration tests for '${item.title}'`, write: false },
                    { title: `Ensure all tests are passing for '${item.title}'`, write: false }
                  ];

                  testingSubtasks.forEach(subtaskOptions => {
                    core.addSubtask(workspaceRoot, item.id, subtaskOptions, tasksData);
                  });
                }

                // Write tasks once with optimized options (status updates may need table updates)
                core.writeTasks(workspaceRoot, tasksData, {
                  recalculatePriorities: false,
                  updateTable: true
                });
                responseData = { success: true, message: `Status of ${subtask ? 'subtask' : 'task'} ${args.id} updated to ${args.newStatus}.` };
              } catch (error) {
                responseData = { success: false, message: `Error updating status: ${error.message}` };
              }
              break;
              
            case 'getNextTask':
              responseData = core.getNextTask(workspaceRoot);
              break;
              
            case 'updateTask':
              responseData = core.updateTask(workspaceRoot, args.id, args);
              break;
              
            case 'updateSubtask':
              responseData = core.updateSubtask(workspaceRoot, args.id, args);
              break;
              
            case 'removeTask':
              responseData = core.removeTask(workspaceRoot, args.id);
              break;
              
            case 'getContext':
              responseData = core.getContext(workspaceRoot, args.id);
              break;
              
            case 'generateTaskFiles':
              responseData = core.generateTaskFiles(workspaceRoot);
              break;
              
            case 'parsePrd':
              responseData = await core.parsePrd(workspaceRoot, args && args.filePath);
              break;
              
            case 'expandTask':
              responseData = await core.expandTask(workspaceRoot, args && args.taskId);
              break;
              
            case 'reviseTasks':
              // Extract parameters from args, not params
              const fromTaskId = args && args.fromTaskId;
              const prompt = args && args.prompt;
              
              if (!fromTaskId || !prompt) {
                logger.error('Missing required parameters for reviseTasks: fromTaskId and/or prompt');
                sendError(id, -32602, 'Missing required parameters for reviseTasks: fromTaskId and/or prompt');
                return;
              }
              
              responseData = await core.reviseTasks(workspaceRoot, fromTaskId, prompt);
              break;
              
            case 'generateTaskTable':
              responseData = core.generateHumanReadableTaskTable(workspaceRoot);
              break;

            // Priority management tools
            case 'recalculatePriorities':
              responseData = core.recalculatePriorities(workspaceRoot, {
                applyDependencyBoosts: args.applyDependencyBoosts !== false,
                applyTimeDecay: args.applyTimeDecay === true,
                optimizeDistribution: args.optimizeDistribution !== false
              });
              break;

            case 'getPriorityStatistics':
              responseData = core.getPriorityStatistics(workspaceRoot);
              break;

            case 'getDependencyAnalysis':
              responseData = core.getDependencyAnalysis(workspaceRoot);
              break;

            case 'configureTimeDecay':
              responseData = core.configureTimeDecay(workspaceRoot, {
                enabled: args.enabled,
                model: args.model,
                rate: args.rate,
                threshold: args.threshold,
                maxBoost: args.maxBoost,
                priorityWeight: args.priorityWeight
              });
              break;

            case 'configureEffortWeighting':
              responseData = core.configureEffortWeighting(workspaceRoot, {
                enabled: args.enabled,
                scoreWeight: args.scoreWeight,
                complexityWeight: args.complexityWeight,
                impactWeight: args.impactWeight,
                urgencyWeight: args.urgencyWeight,
                decayRate: args.decayRate,
                boostThreshold: args.boostThreshold
              });
              break;

            case 'getAdvancedAlgorithmConfig':
              responseData = core.getAdvancedAlgorithmConfig(workspaceRoot);
              break;

            case 'initializeFileWatcher':
              responseData = core.initializeFileWatcher(workspaceRoot, {
                debounceDelay: args.debounceDelay,
                maxQueueSize: args.maxQueueSize,
                enableTaskFiles: args.enableTaskFiles,
                enableTableSync: args.enableTableSync,
                enablePriorityRecalc: args.enablePriorityRecalc
              });
              break;

            case 'stopFileWatcher':
              responseData = core.stopFileWatcher(workspaceRoot);
              break;

            case 'getFileWatcherStatus':
              responseData = core.getFileWatcherStatus(workspaceRoot);
              break;

            case 'forceSyncTaskFiles':
              responseData = await core.forceSyncTaskFiles(workspaceRoot);
              break;

            case 'getPriorityTemplates':
              responseData = core.getPriorityTemplates(workspaceRoot);
              break;

            case 'suggestPriorityTemplate':
              responseData = core.suggestPriorityTemplate(workspaceRoot, args.title, args.description || '');
              break;

            case 'calculatePriorityFromTemplate':
              responseData = core.calculatePriorityFromTemplate(
                workspaceRoot,
                args.templateName,
                args.title,
                args.description || '',
                args.tags || []
              );
              break;

            case 'addTaskWithTemplate':
              responseData = core.addTaskWithTemplate(
                workspaceRoot,
                args.title,
                args.description || '',
                args.templateName,
                args.tags || [],
                {
                  dependsOn: args.dependsOn || [],
                  relatedFiles: args.relatedFiles || []
                }
              );
              break;

            case 'bumpTaskPriority':
              try {
                const amount = args.amount || 50;
                const tasksData = core.readTasks(workspaceRoot);
                const task = tasksData.tasks.find(t => t.id === parseInt(args.id));
                if (!task) {
                  responseData = { success: false, message: `Task with ID ${args.id} not found` };
                  break;
                }
                const oldPriority = task.priority;
                const newPriority = Math.min(1000, task.priority + amount);

                // Update priority directly without calling core.updateTask (which would read tasks again)
                task.priority = newPriority;
                task.updatedAt = new Date().toISOString();

                // Add smart activity log entry
                if (!task.activityLog) task.activityLog = [];
                const priorityDelta = Math.abs(newPriority - oldPriority);

                // Use smart logging for priority changes (configurable threshold)
                const minDelta = 10; // Could be made configurable
                if (priorityDelta >= minDelta) { // Only log if change is significant enough
                  task.activityLog.push({
                    timestamp: new Date().toISOString(),
                    type: 'log',
                    message: `Priority bumped to ${newPriority} (+${amount})`
                  });
                }

                // Write tasks once with optimized options (skip expensive operations for simple priority changes)
                core.writeTasks(workspaceRoot, tasksData, {
                  recalculatePriorities: false,
                  skipTableUpdate: true
                });
                responseData = {
                  success: true,
                  message: `Task ${args.id} priority bumped from ${oldPriority} to ${newPriority}`
                };
              } catch (error) {
                responseData = { success: false, message: `Error bumping priority: ${error.message}` };
              }
              break;

            case 'deferTaskPriority':
              try {
                const amount = args.amount || 50;
                const tasksData = core.readTasks(workspaceRoot);
                const task = tasksData.tasks.find(t => t.id === parseInt(args.id));
                if (!task) {
                  responseData = { success: false, message: `Task with ID ${args.id} not found` };
                  break;
                }
                const oldPriority = task.priority;
                const newPriority = Math.max(1, task.priority - amount);

                // Update priority directly without calling core.updateTask (which would read tasks again)
                task.priority = newPriority;
                task.updatedAt = new Date().toISOString();

                // Add smart activity log entry
                if (!task.activityLog) task.activityLog = [];
                const priorityDelta = Math.abs(oldPriority - newPriority);

                // Use smart logging for priority changes (configurable threshold)
                const minDelta = 10; // Could be made configurable
                if (priorityDelta >= minDelta) { // Only log if change is significant enough
                  task.activityLog.push({
                    timestamp: new Date().toISOString(),
                    type: 'log',
                    message: `Priority deferred to ${newPriority} (-${amount})`
                  });
                }

                // Write tasks once with optimized options (skip expensive operations for simple priority changes)
                core.writeTasks(workspaceRoot, tasksData, {
                  recalculatePriorities: false,
                  skipTableUpdate: true
                });
                responseData = {
                  success: true,
                  message: `Task ${args.id} priority deferred from ${oldPriority} to ${newPriority}`
                };
              } catch (error) {
                responseData = { success: false, message: `Error deferring priority: ${error.message}` };
              }
              break;

            case 'prioritizeTask':
              try {
                const priority = Math.max(800, Math.min(900, args.priority || 850));
                responseData = core.updateTask(workspaceRoot, args.id, { priority });
                if (responseData.success) {
                  responseData.message = `Task ${args.id} prioritized to ${priority}`;
                }
              } catch (error) {
                responseData = { success: false, message: `Error prioritizing task: ${error.message}` };
              }
              break;

            case 'deprioritizeTask':
              try {
                const priority = Math.max(100, Math.min(400, args.priority || 300));
                responseData = core.updateTask(workspaceRoot, args.id, { priority });
                if (responseData.success) {
                  responseData.message = `Task ${args.id} deprioritized to ${priority}`;
                }
              } catch (error) {
                responseData = { success: false, message: `Error deprioritizing task: ${error.message}` };
              }
              break;

            // Filesystem tools
            case 'read_file':
              // Use enhanced read_file with URL support
              if (args.isUrl || (args.path && (args.path.startsWith('http://') || args.path.startsWith('https://')))) {
                responseData = await enhancedFsTools.readFileEnhanced(args.path, allowedDirectories, {
                  isUrl: true,
                  timeout: args.timeout
                });
              } else {
                responseData = filesystemTools.readFile(args.path, allowedDirectories);
              }
              break;
              
            case 'read_multiple_files':
              responseData = filesystemTools.readMultipleFiles(args.paths, allowedDirectories);
              break;
              
            case 'write_file':
              // Check if we're in readonly mode
              if (!checkReadOnlyMode('write_file')) {
                responseData = { 
                  success: false, 
                  message: 'Operation not allowed: Server is running in read-only mode'
                };
                break;
              }
              responseData = filesystemTools.writeFile(args.path, args.content, allowedDirectories);
              break;
              
            case 'copy_file':
              // Check if we're in readonly mode
              if (!checkReadOnlyMode('copy_file')) {
                responseData = { 
                  success: false, 
                  message: 'Operation not allowed: Server is running in read-only mode'
                };
                break;
              }
              responseData = filesystemTools.copyFile(args.source, args.destination, allowedDirectories);
              break;
              
            case 'move_file':
              // Check if we're in readonly mode
              if (!checkReadOnlyMode('move_file')) {
                responseData = { 
                  success: false, 
                  message: 'Operation not allowed: Server is running in read-only mode'
                };
                break;
              }
              responseData = filesystemTools.moveFile(args.source, args.destination, allowedDirectories);
              break;
              
            case 'delete_file':
              // Check if we're in readonly mode
              if (!checkReadOnlyMode('delete_file')) {
                responseData = { 
                  success: false, 
                  message: 'Operation not allowed: Server is running in read-only mode'
                };
                break;
              }
              responseData = filesystemTools.deleteFile(args.path, args.recursive, allowedDirectories);
              break;
              
            case 'list_directory':
              responseData = filesystemTools.listDirectory(args.path, allowedDirectories);
              break;
              
            case 'create_directory':
              // Check if we're in readonly mode
              if (!checkReadOnlyMode('create_directory')) {
                responseData = { 
                  success: false, 
                  message: 'Operation not allowed: Server is running in read-only mode'
                };
                break;
              }
              responseData = filesystemTools.createDirectory(args.path, allowedDirectories);
              break;
              
            case 'tree':
              responseData = filesystemTools.createDirectoryTree(
                args.path, 
                args.depth || 3, 
                args.follow_symlinks || false, 
                allowedDirectories
              );
              break;
              
            case 'search_files':
              responseData = filesystemTools.searchFiles(args.path, args.pattern, allowedDirectories);
              break;
              
            case 'get_file_info':
              responseData = filesystemTools.getFileInfo(args.path, allowedDirectories);
              break;
              
            case 'list_allowed_directories':
              responseData = filesystemTools.listAllowedDirectories(allowedDirectories);
              break;
              
            case 'get_filesystem_status':
              // Return the current status of filesystem operations
              responseData = {
                success: true,
                readonly_mode: readonlyMode,
                allowed_directories: allowedDirectories.map(dir => ({
                  path: dir,
                  resolvedPath: path.resolve(dir),
                  exists: fs.existsSync(path.resolve(dir))
                })),
                workspace_root: workspaceRoot
              };
              break;
              
            // Desktop Commander MCP Tools cases
            case 'get_config':
              responseData = terminalTools.getConfig();
              break;
              
            case 'set_config_value':
              responseData = terminalTools.setConfigValue(args.key, args.value);
              break;
              
            case 'execute_command':
              responseData = await terminalTools.executeCommand(args.command, {
                shell: args.shell,
                timeout_ms: args.timeout_ms ? parseInt(args.timeout_ms, 10) : undefined
              });
              break;
              
            case 'read_output':
              responseData = terminalTools.readOutput(args.pid);
              break;
              
            case 'force_terminate':
              responseData = await terminalTools.forceTerminate(args.pid);
              break;
              
            case 'list_sessions':
              responseData = terminalTools.listSessions();
              break;
              
            case 'list_processes':
              responseData = await terminalTools.listProcesses();
              break;
              
            case 'kill_process':
              responseData = await terminalTools.killProcess(args.pid);
              break;
              
            case 'search_code':
              responseData = await searchTools.searchCode(args.path, args.pattern, {
                ignoreCase: args.ignoreCase,
                filePattern: args.filePattern,
                contextLines: args.contextLines,
                includeHidden: args.includeHidden,
                maxResults: args.maxResults,
                timeoutMs: args.timeoutMs
              });
              break;
              
            case 'edit_block':
              responseData = editTools.editBlock(args.file_path, args.old_string, args.new_string, {
                expected_replacements: args.expected_replacements
              });
              break;
              
            // Playwright MCP Browser Tools cases
            case 'browser_navigate':
              responseData = await browserTools.browserNavigate(args.url);
              break;
              
            case 'browser_navigate_back':
              responseData = await browserTools.browserNavigateBack();
              break;
              
            case 'browser_navigate_forward':
              responseData = await browserTools.browserNavigateForward();
              break;
              
            case 'browser_click':
              responseData = await browserTools.browserClick(args.element, args.ref);
              break;
              
            case 'browser_type':
              responseData = await browserTools.browserType(args.element, args.ref, args.text, {
                submit: args.submit,
                slowly: args.slowly
              });
              break;
              
            case 'browser_hover':
              responseData = await browserTools.browserHover(args.element, args.ref);
              break;
              
            case 'browser_drag':
              responseData = await browserTools.browserDrag(args.startElement, args.startRef, args.endElement, args.endRef);
              break;
              
            case 'browser_select_option':
              responseData = await browserTools.browserSelectOption(args.element, args.ref, args.values);
              break;
              
            case 'browser_press_key':
              responseData = await browserTools.browserPressKey(args.key);
              break;
              
            case 'browser_take_screenshot':
              responseData = await browserTools.browserTakeScreenshot({
                element: args.element,
                ref: args.ref,
                filename: args.filename,
                raw: args.raw
              });
              break;
              
            case 'browser_snapshot':
              responseData = await browserTools.browserSnapshot();
              break;
              
            case 'browser_pdf_save':
              responseData = await browserTools.browserPdfSave({
                filename: args.filename
              });
              break;
              
            case 'browser_console_messages':
              responseData = await browserTools.browserConsoleMessages();
              break;
              
            case 'browser_file_upload':
              responseData = await browserTools.browserFileUpload(args.paths);
              break;
              
            case 'browser_wait':
              responseData = await browserTools.browserWait(args.time);
              break;
              
            case 'browser_wait_for':
              responseData = await browserTools.browserWaitFor({
                text: args.text,
                textGone: args.textGone,
                time: args.time
              });
              break;
              
            case 'browser_resize':
              responseData = await browserTools.browserResize(args.width, args.height);
              break;
              
            case 'browser_handle_dialog':
              responseData = await browserTools.browserHandleDialog(args.accept, args.promptText);
              break;
              
            case 'browser_close':
              responseData = await browserTools.browserClose();
              break;
              
            case 'browser_install':
              responseData = await browserTools.browserInstall();
              break;
              
            case 'browser_tab_list':
              responseData = await browserTools.browserTabList();
              break;
              
            case 'browser_tab_new':
              responseData = await browserTools.browserTabNew(args.url);
              break;
              
            case 'browser_tab_select':
              responseData = await browserTools.browserTabSelect(args.index);
              break;
              
            case 'browser_tab_close':
              responseData = await browserTools.browserTabClose(args.index);
              break;
              
            case 'browser_network_requests':
              responseData = await browserTools.browserNetworkRequests();
              break;
              
            // AppleScript Tool case
            case 'applescript_execute':
              responseData = await applescriptTools.executeAppleScript(
                args.code_snippet,
                args.timeout || 60
              );
              break;
              
            default:
              logger.error(`Unknown tool requested: ${toolName}`);
              sendError(id, -32601, `Method not found: ${toolName}`);
              return;
          }
          
          logger.debug(`Tool "${toolName}" executed successfully`);
          
          // Format the response specifically for MCP
          // If responseData is already MCP formatted, return it as-is
          if (method === 'tools/call') {
            // Handle tools/call response (newer MCP format)
            if (typeof responseData === 'string') {
              // Text response
              sendResponse(id, {
                content: [
                  {
                    type: "text",
                    text: responseData
                  }
                ]
              });
            } else {
              // JSON response
              sendResponse(id, {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(responseData)
                  }
                ]
              });
            }
          } else {
            // Handle tools/run response (older MCP format)
            sendResponse(id, responseData);
          }
          
        } catch (error) {
          logger.error(`Error executing tool ${toolName}: ${error.message}`);
          logger.debug(error.stack);
          
          sendError(id, -32000, `Error executing tool ${toolName}: ${error.message}`, { 
            stack: error.stack
          });
        }
        break;
        
      default:
        logger.error(`Unknown method requested: ${method}`);
        sendError(id, -32601, `Method not found: ${method}`);
    }
  } catch (error) {
    logger.error(`Error processing request: ${error.message}`);
    logger.debug(error.stack);
    
    if (requestId !== null) {
      sendError(requestId, -32603, `Internal error: ${error.message}`, { 
        stack: error.stack
      });
    }
  }
});

logger.info('Server ready and listening for requests');

// Prevent the process from exiting
process.stdin.resume(); 