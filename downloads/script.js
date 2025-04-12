const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const qrcode = require('qrcode-terminal');

const DOWNLOADS_DIR = path.join(__dirname, 'downloads');
const MAX_QUEUE = 10;
let downloadQueue = [];

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

            try {
                await msg.react("⏳");
                downloadQueue.push(msg.id.id);

                const result = await runPythonDownloader(query, isBook ? 'book' : 'paper');

                if (result.status === 'success') {
                    const filePath = path.resolve(result.file_path);
                    console.log('📁 Checking for file at:', filePath);

                    if (!fs.existsSync(filePath)) {
                        throw new Error("📂 File not found after Python download");
                    }

                    const media = MessageMedia.fromFilePath(filePath);
                    await msg.reply(media, undefined, {
                        caption: `✅ *${result.message}*`,
                        quotedMessageId: msg.id._serialized
                    });

                    // Send cover if exists
                    if (result.cover && fs.existsSync(result.cover)) {
                        const cover = MessageMedia.fromFilePath(result.cover);
                        await msg.reply(cover, undefined, {
                            caption: "📚 Here's the book cover!",
                            quotedMessageId: msg.id._serialized
                        });
                    }

                    // Delay cleanup to avoid race conditions
                    setTimeout(() => {
                        try {
                            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                            if (result.cover && fs.existsSync(result.cover)) fs.unlinkSync(result.cover);
                            console.log("🧹 Cleaned up downloaded files.");
                        } catch (cleanupErr) {
                            console.error("Cleanup error:", cleanupErr);
                        }
                    }, 10000); // 10s delay

                } else {
                    await msg.reply(`❌ ${result.message}\n\n🔎 Suggestions:\n${(result.alternatives || []).join('\n')}`);
                }

            } catch (err) {
                console.error("⚠️ Error during download/send:", err);
                await msg.reply("⚠️ Something went wrong. Please try again.");
            } finally {
                downloadQueue = downloadQueue.filter(id => id !== msg.id.id);
                try {
                    await msg.react("✅").catch(() => msg.react("❌"));
                } catch (reactErr) {
                    console.error("❌ Reaction error:", reactErr);
                }
            }
        }
    }
});

function runPythonDownloader(query, type = 'book') {
    return new Promise((resolve, reject) => {
        const py = spawn('python', ['Downloader.py', query, '--type', type], { cwd: __dirname });

        let data = '';
        let error = '';

        py.stdout.on('data', chunk => data += chunk.toString());
        py.stderr.on('data', chunk => error += chunk.toString());

        py.on('error', err => reject(`Python error: ${err.message}`));

        py.on('close', code => {
            if (code !== 0 || error) return reject(error || `Python exited with code ${code}`);
            try {
                const result = JSON.parse(data.trim());
                resolve(result);
            } catch (err) {
                reject(`Invalid Python output:\n${data}`);
            }
        });
    });
}

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
