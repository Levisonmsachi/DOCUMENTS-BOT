const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');
const { v4: uuidv4 } = require('uuid'); // Add this dependency for unique IDs

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const MAX_QUEUE = 10;
const CONCURRENT_PYTHON_PROCESSES = 3; // Limit concurrent Python processes

// Track active downloads and pending requests
let downloadQueue = [];
let activeDownloads = new Map(); // messageId -> {query, type, timestamp, ...}
let runningPythonProcesses = 0;
let pythonQueue = [];

// Ensure downloads folder exists
if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

// Display QR for login
client.on('qr', qr => {
    console.log('📸 QR CODE RECEIVED');
    qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => console.log('✅ Authenticated'));
client.on('auth_failure', msg => console.error('❌ Auth Failed:', msg));
client.on('ready', () => console.log('🤖 LEVVIE-LIVVIE BOT is ready!'));

client.on('message_create', async (msg) => {
    if (msg.from === 'status@broadcast') return;

    if (!msg.fromMe && msg.from.endsWith('@g.us')) {
        const body = msg.body.trim();
        if (body.startsWith('.book ') || body.startsWith('.paper ')) {
            if (downloadQueue.length >= MAX_QUEUE) {
                return msg.reply("🚦 Queue full. Try again shortly.");
            }

            const isBook = body.startsWith('.book ');
            const query = body.slice(isBook ? 6 : 7).trim();
            if (!query) return msg.reply("❌ Please provide a title.");

            // Generate a unique request ID
            const requestId = uuidv4();
            
            try {
                await msg.react("⏳");
                downloadQueue.push(requestId);
                
                // Store the download request details
                activeDownloads.set(requestId, {
                    messageId: msg.id.id,
                    query: query,
                    type: isBook ? 'book' : 'paper',
                    timestamp: Date.now(),
                    chatId: msg.from,
                    quotedMsgId: msg.id._serialized,
                    status: 'queued',
                    isBook: isBook  // Explicitly track if this is a book request
                });

                console.log(`📚 New ${isBook ? 'book' : 'paper'} request [${requestId}]: "${query}"`);
                
                processDownloadRequest(requestId, msg);
                
            } catch (err) {
                console.error(`⚠️ Error initializing request [${requestId}]:`, err);
                cleanupRequest(requestId);
                await msg.reply("⚠️ Something went wrong. Please try again.");
                try { await msg.react("❌"); } catch (reactErr) {}
            }
        }
    }
});

// Process download requests, respecting concurrency limits
async function processDownloadRequest(requestId, msg) {
    // Check if we're at the Python process limit
    if (runningPythonProcesses >= CONCURRENT_PYTHON_PROCESSES) {
        console.log(`⏳ Queuing request [${requestId}] - ${runningPythonProcesses}/${CONCURRENT_PYTHON_PROCESSES} processes running`);
        pythonQueue.push({ requestId, msg });
        return;
    }
    
    // Update status and increment counter
    const downloadInfo = activeDownloads.get(requestId);
    if (!downloadInfo) return; // Request was cancelled
    
    downloadInfo.status = 'processing';
    activeDownloads.set(requestId, downloadInfo);
    runningPythonProcesses++;
    
    try {
        console.log(`🚀 Processing request [${requestId}] - "${downloadInfo.query}"`);
        
        // Run Python downloader
        const result = await runPythonDownloader(downloadInfo.query, downloadInfo.type, requestId);
        
        // Handle the result
        if (result.status === 'success') {
            // Check if the file exists or search for it
            let filePath = null;
            
            if (result.file_path && fs.existsSync(path.resolve(result.file_path))) {
                filePath = path.resolve(result.file_path);
                console.log(`📁 [${requestId}] Found file at path provided by Python: ${filePath}`);
            } else {
                // Search for matching file
                const foundFile = await findMatchingFile(downloadInfo.query, downloadInfo.type === 'book');
                if (foundFile) {
                    filePath = foundFile;
                    console.log(`🔍 [${requestId}] Found matching file: ${filePath}`);
                }
            }
            
            if (filePath) {
                // Found a file to send
                await sendFileToUser(msg, filePath, {
                    ...result,
                    message: result.message || `Found "${path.basename(filePath)}"`
                }, requestId);
                
                downloadInfo.status = 'completed';
                activeDownloads.set(requestId, downloadInfo);
            } else {
                throw new Error("📂 No matching file found after successful download");
            }
        } else {
            // Python reported an error
            console.log(`❌ [${requestId}] Python error: ${result.message}`);
            await msg.reply(`❌ ${result.message}\n\n🔎 Suggestions:\n${(result.alternatives || []).join('\n')}`);
            downloadInfo.status = 'failed';
            activeDownloads.set(requestId, downloadInfo);
        }
        
    } catch (err) {
        console.error(`⚠️ Error processing request [${requestId}]:`, err);
        try {
            await msg.reply("⚠️ Something went wrong. Please try again.");
            if (activeDownloads.has(requestId)) {
                const info = activeDownloads.get(requestId);
                info.status = 'failed';
                info.error = err.message;
                activeDownloads.set(requestId, info);
            }
        } catch (replyErr) {
            console.error(`Failed to send error reply for [${requestId}]:`, replyErr);
        }
    } finally {
        // Mark process as completed
        runningPythonProcesses--;
        
        // Update UI
        try {
            await msg.react("✅").catch(() => msg.react("❌"));
        } catch (reactErr) {}
        
        // Process next request if any
        processNextInQueue();
        
        // Schedule cleanup
        setTimeout(() => cleanupRequest(requestId), 60000); // Clean up after 1 minute
    }
}

// Process the next request in the queue
function processNextInQueue() {
    if (pythonQueue.length > 0 && runningPythonProcesses < CONCURRENT_PYTHON_PROCESSES) {
        const next = pythonQueue.shift();
        console.log(`⏩ Processing next queued request [${next.requestId}]`);
        processDownloadRequest(next.requestId, next.msg);
    }
}

// Send file to the user
async function sendFileToUser(msg, filePath, result, requestId) {
    try {
        console.log(`📤 [${requestId}] Sending file: ${path.basename(filePath)}`);
        const startTime = Date.now();
        
        // Generate media from file
        const media = MessageMedia.fromFilePath(filePath);
        
        // Calculate file size in MB
        const fileSizeMB = (media.data.length * 0.75) / (1024 * 1024); // Base64 encoding adds ~33% overhead
        console.log(`📊 [${requestId}] File size: ${fileSizeMB.toFixed(2)} MB`);
        
        // Send the file
        await msg.reply(media, undefined, {
            caption: `✅ *${result.message || 'Download successful!'}*`,
            quotedMessageId: msg.id._serialized
        });
        
        const sendTime = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`✅ [${requestId}] File sent in ${sendTime}s`);

        // Send cover if exists
        if (result.cover && fs.existsSync(result.cover)) {
            console.log(`🖼️ [${requestId}] Sending cover image`);
            const cover = MessageMedia.fromFilePath(result.cover);
            await msg.reply(cover, undefined, {
                caption: "📚 Here's the book cover!",
                quotedMessageId: msg.id._serialized
            });
        }

        // Schedule file cleanup with unique timeout for each file
        const cleanupTimeout = setTimeout(() => {
            try {
                if (fs.existsSync(filePath)) {
                    fs.unlinkSync(filePath);
                    console.log(`🧹 [${requestId}] Cleaned up file: ${path.basename(filePath)}`);
                }
                if (result.cover && fs.existsSync(result.cover)) {
                    fs.unlinkSync(result.cover);
                    console.log(`🧹 [${requestId}] Cleaned up cover image`);
                }
            } catch (cleanupErr) {
                console.error(`⚠️ [${requestId}] Cleanup error:`, cleanupErr);
            }
        }, 10000 + Math.random() * 5000); // Random delay between 10-15s to avoid concurrent deletions
        
        // Store the timeout reference
        if (activeDownloads.has(requestId)) {
            const info = activeDownloads.get(requestId);
            info.cleanupTimeout = cleanupTimeout;
            activeDownloads.set(requestId, info);
        }
        
    } catch (error) {
        console.error(`⚠️ [${requestId}] Error sending file:`, error);
        throw error;
    }
}

// Function to find a matching file in downloads folder
async function findMatchingFile(query, isBook) {
    try {
        // Get all files in downloads directory
        const files = fs.readdirSync(DOWNLOADS_DIR)
            .filter(file => file.toLowerCase().endsWith('.pdf'))
            .map(file => ({
                name: file,
                path: path.join(DOWNLOADS_DIR, file),
                mtime: fs.statSync(path.join(DOWNLOADS_DIR, file)).mtime
            }))
            .sort((a, b) => b.mtime - a.mtime); // Sort newest first
        
        if (files.length === 0) {
            return null;
        }
        
        // Prepare query terms for matching
        const queryTerms = query.toLowerCase().split(/\s+/).filter(term => term.length > 1);
        
        // First look for exact matches (contains the whole query)
        const exactMatch = files.find(file => {
            const filename = file.name.toLowerCase();
            return queryTerms.every(term => filename.includes(term));
        });
        
        if (exactMatch) {
            return exactMatch.path;
        }
        
        // Then look for partial matches (contains at least half of the query terms)
        const halfTermsCount = Math.max(1, Math.ceil(queryTerms.length / 2));
        const partialMatch = files.find(file => {
            const filename = file.name.toLowerCase();
            const matchingTerms = queryTerms.filter(term => filename.includes(term));
            return matchingTerms.length >= halfTermsCount;
        });
        
        if (partialMatch) {
            return partialMatch.path;
        }
        
        // If no match found, return the most recent file as fallback
        if (files.length > 0) {
            return files[0].path;
        }
        
        return null;
    } catch (error) {
        console.error("Error finding matching file:", error);
        return null;
    }
}

// Run Python downloader with request ID for tracking
// Run Python downloader with request ID for tracking
function runPythonDownloader(query, type = 'book', requestId) {
    return new Promise((resolve, reject) => {
        console.log(`🐍 [${requestId}] Running Python for "${query}" (${type})`);
        const startTime = Date.now();
        
        const py = spawn('python', ['Downloader.py', query, '--type', type], { 
            cwd: __dirname,
            // Set timeout and memory limits to prevent runaway processes
            timeout: 20 * 60 * 1000  // 20 minutes timeout
        });

        let data = '';
        let error = '';

        py.stdout.on('data', chunk => {
            const chunkStr = chunk.toString();
            data += chunkStr;
            // Log progress indicators if present
            if (chunkStr.includes('%') || chunkStr.includes('...')) {
                console.log(`📊 [${requestId}] Progress: ${chunkStr.trim()}`);
            }
        });
        
        py.stderr.on('data', chunk => {
            error += chunk.toString();
            console.error(`⚠️ [${requestId}] Python stderr: ${chunk.toString().trim()}`);
        });

        py.on('error', err => {
            console.error(`💥 [${requestId}] Python process error:`, err);
            reject(`Python error: ${err.message}`);
        });

        py.on('close', code => {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            console.log(`⏱️ [${requestId}] Python finished in ${elapsed}s with exit code ${code}`);
            
            if (code !== 0 || error) {
                return reject(error || `Python exited with code ${code}`);
            }
            
            try {
                const trimmedData = data.trim();
                
                // Special handling for "SUCCESS" message
                if (trimmedData.includes('SUCCESS')) {
                    console.log(`✅ [${requestId}] Python reported SUCCESS, searching for downloaded file`);
                    // Return a success result without a file path - we'll search for the file
                    resolve({
                        status: 'success',
                        message: 'Download successful! Looking for the file...'
                    });
                    return;
                }
                
                // Normal JSON parsing for standard results
                try {
                    const result = JSON.parse(trimmedData);
                    resolve(result);
                } catch (jsonErr) {
                    console.warn(`⚠️ [${requestId}] Not valid JSON, checking for success indicators`);
                    
                    // Check for other success indicators in the output
                    if (
                        trimmedData.toLowerCase().includes('download') && 
                        (trimmedData.toLowerCase().includes('success') || trimmedData.toLowerCase().includes('complete'))
                    ) {
                        console.log(`✅ [${requestId}] Found success indicator in output`);
                        resolve({
                            status: 'success',
                            message: 'Download completed successfully!'
                        });
                    } else {
                        // No success indicators found, treat as error
                        reject(`Invalid Python output:\n${trimmedData}`);
                    }
                }
            } catch (err) {
                console.error(`⚠️ [${requestId}] Error processing Python output:`, err);
                reject(`Error processing Python output:\n${data}`);
            }
        });
    });
}

// Function to find a matching file in downloads folder with improved recent file detection
async function findMatchingFile(query, isBook) {
    try {
        console.log(`🔍 Searching for ${isBook ? 'book' : 'paper'}: "${query}"`);
        
        // Get all PDF files sorted by creation time (newest first)
        const files = fs.readdirSync(DOWNLOADS_DIR)
            .filter(file => file.toLowerCase().endsWith('.pdf'))
            .map(file => {
                const filePath = path.join(DOWNLOADS_DIR, file);
                const stats = fs.statSync(filePath);
                return {
                    name: file,
                    path: filePath,
                    size: stats.size,
                    ctime: stats.ctime,
                    isRecent: (Date.now() - stats.ctime.getTime() < 60000) // Created in last minute
                };
            })
            .sort((a, b) => b.ctime - a.ctime); // Newest files first

        if (files.length === 0) {
            console.log('❌ No PDF files found in downloads directory');
            return null;
        }

        // Prepare query terms (remove small words and special characters)
        const queryTerms = query.toLowerCase()
            .replace(/[^\w\s]/g, '') // Remove special chars
            .split(/\s+/)
            .filter(term => term.length > 2); // Ignore short terms

        // Score function for matching
        const getMatchScore = (filename) => {
            const name = filename.toLowerCase();
            let score = 0;
            
            // Exact matches get highest score
            if (name.includes(query.toLowerCase())) {
                score += 100;
            }
            
            // Match individual terms
            queryTerms.forEach(term => {
                if (name.includes(term)) score += 10;
            });
            
            return score;
        };

        // For past papers, extract course code and year if available
        if (!isBook) {
            const courseCodeMatch = query.match(/[A-Za-z]{2,4}\s?\d{3}/);
            const courseCode = courseCodeMatch ? courseCodeMatch[0].replace(/\s/g, '').toUpperCase() : null;
            const yearMatch = query.match(/(19|20)\d{2}/);
            const year = yearMatch ? yearMatch[0] : null;
            
            if (courseCode || year) {
                // Find files that match course code and/or year
                const codeYearMatches = files.filter(file => {
                    const name = file.name.toUpperCase();
                    return (courseCode && name.includes(courseCode)) || 
                           (year && name.includes(year));
                });
                
                if (codeYearMatches.length > 0) {
                    // Among matching files, find the best title match
                    codeYearMatches.forEach(file => {
                        file.score = getMatchScore(file.name) + 50; // Bonus for code/year match
                    });
                    
                    codeYearMatches.sort((a, b) => b.score - a.score);
                    console.log(`📄 Found ${codeYearMatches.length} paper matches, best: ${codeYearMatches[0].name}`);
                    return codeYearMatches[0].path;
                }
            }
        }

        // For all files (or if no course code/year match found), score them
        files.forEach(file => {
            file.score = getMatchScore(file.name);
            
            // Bonus for recent files
            if (file.isRecent) file.score += 20;
            
            // Bonus for larger files (likely complete downloads)
            if (file.size > 1024 * 1024) file.score += 10; // Files >1MB get bonus
        });

        // Sort by score (highest first)
        files.sort((a, b) => b.score - a.score);
        
        // Debug output
        console.log('Top file matches:');
        files.slice(0, 3).forEach(file => {
            console.log(`- ${file.name} (score: ${file.score}, size: ${(file.size/1024/1024).toFixed(2)}MB)`);
        });

        // Return best match if we have a decent score
        if (files[0].score >= 10) {
            console.log(`✅ Best match: ${files[0].name}`);
            return files[0].path;
        }

        // Fallback to most recent file if no good matches
        console.log(`⚠️ No strong matches, using most recent file: ${files[0].name}`);
        return files[0].path;

    } catch (error) {
        console.error("Error finding matching file:", error);
        return null;
    }
}

// Clean up a request's resources
function cleanupRequest(requestId) {
    if (!activeDownloads.has(requestId)) return;
    
    const downloadInfo = activeDownloads.get(requestId);
    
    // Clear any pending timeouts
    if (downloadInfo.cleanupTimeout) {
        clearTimeout(downloadInfo.cleanupTimeout);
    }
    
    // Remove from queue
    downloadQueue = downloadQueue.filter(id => id !== requestId);
    
    // Remove from active downloads
    activeDownloads.delete(requestId);
    
    console.log(`🧹 Cleaned up request [${requestId}]`);
}

// File system watcher with debounce to prevent duplicate events
let fsWatcherTimeout = null;
const fsWatcher = fs.watch(DOWNLOADS_DIR, (eventType, filename) => {
    if (!filename || !filename.toLowerCase().endsWith('.pdf')) return;
    
    // Debounce file detection events
    clearTimeout(fsWatcherTimeout);
    fsWatcherTimeout = setTimeout(() => {
        if (eventType === 'rename') {
            console.log(`📁 New file detected: ${filename}`);
            checkForPendingRequests(filename);
        }
    }, 500); // Wait 500ms to avoid duplicate events
});

// Check if any pending requests match the new file
function checkForPendingRequests(filename) {
    if (activeDownloads.size === 0) return;
    
    const filePath = path.join(DOWNLOADS_DIR, filename);
    if (!fs.existsSync(filePath)) return;
    
    const filenameLower = filename.toLowerCase();
    const matches = [];
    
    // Find any matching requests
    for (const [requestId, download] of activeDownloads.entries()) {
        if (download.status !== 'processing') continue;
        
        const queryTerms = download.query.toLowerCase().split(/\s+/);
        const isMatch = queryTerms.some(term => term.length > 1 && filenameLower.includes(term));
        
        if (isMatch) {
            console.log(`✅ Found match for request [${requestId}] in new file "${filename}"`);
            matches.push(requestId);
        }
    }
    
    console.log(`📊 Found ${matches.length} matching requests for file "${filename}"`);
}

// Clean up stale downloads periodically
setInterval(() => {
    const now = Date.now();
    const ONE_HOUR = 60 * 60 * 1000;
    let cleanedCount = 0;
    
    for (const [requestId, download] of activeDownloads.entries()) {
        if (now - download.timestamp > ONE_HOUR) {
            cleanupRequest(requestId);
            cleanedCount++;
        }
    }
    
    if (cleanedCount > 0) {
        console.log(`🧹 Cleaned up ${cleanedCount} stale download requests`);
    }
}, 30 * 60 * 1000); // Every 30 minutes

// Welcome new group members
client.on('group_join', async (notification) => {
    try {
        const contact = await client.getContactById(notification.id.participant);
        const chat = await client.getChatById(notification.chatId);

        await chat.sendMessage(
            `👋 Welcome @${contact.number}!\n\n📘 To get a book, type: *.book <title>*\n📄 For past papers: *.paper <subject>*\n\n📌 Type *.menu* for help.`,
            { mentions: [contact] }
        );
    } catch (err) {
        console.error('Welcome error:', err);
    }
});

// Menu command
client.on('message', async msg => {
    if (msg.body === '.menu' && msg.from.endsWith('@g.us')) {
        try {
            await msg.reply(
                `📚 *LEVVIE-LIVVIE DOCUMENTS BOT*\n\n` +
                `📝 Commands:\n` +
                `➡️ *.book <title>* - Download a book\n` +
                `➡️ *.paper <subject>* - Download past papers\n` +
                `➡️ *.menu* - Show this menu\n\n` +
                `⏳ Max queue: ${MAX_QUEUE} downloads\n` +
                `🧠 Built by Levison Msachi 💡`
            );
        } catch (err) {
            console.error('Menu error:', err);
        }
    }
});

// Status command (admin only)
client.on('message', async msg => {
    if (msg.body === '.status' && msg.fromMe) {
        try {
            const activeCount = downloadQueue.length;
            const pythonCount = runningPythonProcesses;
            const queuedCount = pythonQueue.length;
            
            // Get status breakdown
            const statusCounts = {};
            for (const [_, download] of activeDownloads.entries()) {
                statusCounts[download.status] = (statusCounts[download.status] || 0) + 1;
            }
            
            const statusText = Object.entries(statusCounts)
                .map(([status, count]) => `${status}: ${count}`)
                .join(', ');
            
            await msg.reply(
                `📊 *BOT STATUS*\n\n` +
                `Active downloads: ${activeCount}/${MAX_QUEUE}\n` +
                `Python processes: ${pythonCount}/${CONCURRENT_PYTHON_PROCESSES}\n` +
                `Queued requests: ${queuedCount}\n` +
                `Status breakdown: ${statusText || 'none'}\n\n` +
                `🕒 ${new Date().toLocaleString()}`
            );
        } catch (err) {
            console.error('Status error:', err);
        }
    }
});

// Clean up on exit
process.on('exit', () => {
    if (fsWatcher) fsWatcher.close();
});

// Startup error handling
client.initialize().catch(err => {
    console.error('Startup error:', err);
    process.exit(1);
});

// Catch process errors
process.on('unhandledRejection', (reason, p) => {
    console.error('Unhandled rejection:', reason);
});
process.on('uncaughtException', err => {
    console.error('Uncaught exception:', err);
});