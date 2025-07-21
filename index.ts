import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  TextChannel,
  ThreadChannel,
  Message,
  InteractionReplyOptions,
  ChannelType,
} from "discord.js";
import Database from "better-sqlite3";
import { existsSync, mkdirSync, } from "fs";
import path from "path";

// Function to ensure data directory and database exist
function ensureDataDirectoryAndDatabase(dataDir: string, dbPath: string): void {
  console.log('🔧 Checking data directory and database...');
  
  // Check and create data directory
  if (!existsSync(dataDir)) {
    console.log(`📁 Data directory doesn't exist. Creating: ${dataDir}`);
    try {
      mkdirSync(dataDir, { recursive: true, mode: 0o775 });
      console.log('✅ Data directory created successfully');
    } catch (error) {
      console.error('❌ Failed to create data directory:', error);
      throw new Error(`Cannot create data directory: ${dataDir}`);
    }
  } else {
    console.log('✅ Data directory already exists');
  }
  
  // Test write permissions by creating a test file
  const testFile = path.join(dataDir, 'test-write-permissions.tmp');
  try {
    const fs = require('fs');
    fs.writeFileSync(testFile, 'test');
    fs.unlinkSync(testFile);
    console.log('✅ Write permissions verified for data directory');
  } catch (writeError) {
    console.error('❌ No write permissions to data directory:', writeError);
    console.error('Directory stats:', require('fs').statSync(dataDir));
    console.error('Process UID:', process.getuid?.() || 'unknown');
    console.error('Process GID:', process.getgid?.() || 'unknown');
    throw new Error(`Cannot write to data directory: ${dataDir}`);
  }
  
  // Check database file
  if (!existsSync(dbPath)) {
    console.log(`🗄️ Database file doesn't exist. It will be created: ${dbPath}`);
    // Try to pre-create the database file with proper permissions
    try {
      const fs = require('fs');
      fs.writeFileSync(dbPath, '', { mode: 0o664 });
      console.log('✅ Database file pre-created successfully');
    } catch (createError) {
      console.warn('⚠️ Could not pre-create database file (SQLite will try):', createError);
    }
  } else {
    console.log('✅ Database file already exists');
    try {
      const fs = require('fs');
      const stats = fs.statSync(dbPath);
      console.log('Database file stats:', {
        size: stats.size,
        mode: '0' + (stats.mode & parseInt('777', 8)).toString(8),
        uid: stats.uid,
        gid: stats.gid
      });
    } catch (statError) {
      console.warn('⚠️ Could not get database file stats:', statError);
    }
  }
}

// Check if .data directory and database file exist
const dataDir = path.join(process.cwd(), '.data');
const dbPath = path.join(dataDir, 'reaction_cleaner.db');

console.log(`📄 Initializing SQLite at: ${dbPath}`); // Will throw if path is invalid
console.log('Current working directory:', process.cwd());
console.log('Data directory path:', dataDir);
console.log('Database file path:', dbPath);

// Ensure directory and database exist before proceeding
ensureDataDirectoryAndDatabase(dataDir, dbPath);

console.log('Data directory exists:', existsSync(dataDir));
console.log('Database file exists:', existsSync(dbPath));

// Initialize SQLite database (this will create the file if it doesn't exist)
let db: Database.Database;
try {
  db = new Database(dbPath, {
    verbose: process.env.NODE_ENV === 'development' ? console.log : undefined
  });
  console.log('✅ Database connection established');
} catch (error) {
  console.error('❌ Failed to initialize database:', error);
  process.exit(1);
}

// Create table if it doesn't exist
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tracked_messages (
      message_url TEXT PRIMARY KEY,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      added_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
  console.log('✅ Database table initialized');
} catch (error) {
  console.error('❌ Failed to create database table:', error);
  process.exit(1);
}

// Define the database row type
interface TrackedMessage {
  message_url: string;
  channel_id: string;
  message_id: string;
  added_at: string;
}

// Define type for count query result
interface CountResult {
  count: number;
}

// Define type for database operation results - this was the main issue
interface DatabaseRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

// Prepared statements for better performance
const insertMessage = db.prepare("INSERT OR IGNORE INTO tracked_messages (message_url, channel_id, message_id) VALUES (?, ?, ?)");
const deleteMessage = db.prepare("DELETE FROM tracked_messages WHERE message_url = ?");
const getAllMessages = db.prepare("SELECT * FROM tracked_messages");
const clearAllMessages = db.prepare("DELETE FROM tracked_messages");

// Test database connection and log initial state
console.log("🧪 Testing database connection...");
try {
  const testQuery = db.prepare("SELECT COUNT(*) as count FROM tracked_messages").get() as CountResult;
  console.log(`✅ Database connection successful. Current messages in DB: ${testQuery.count}`);
} catch (error) {
  console.error("❌ Database connection test failed:", error);
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// Store cleaning intervals by message URL
const cleaningTasks: Record<string, NodeJS.Timeout> = {};

// Enhanced function to parse Discord message URLs (supports threads and forum posts)
function parseMessageUrl(messageUrl: string): { channelId: string; messageId: string } | null {
  try {
    // Discord message URL patterns:
    // Regular channel: https://discord.com/channels/GUILD_ID/CHANNEL_ID/MESSAGE_ID
    // Thread: https://discord.com/channels/GUILD_ID/CHANNEL_ID/MESSAGE_ID (same format)
    // The channel_id in threads is the thread ID, not the parent channel ID
    
    const url = new URL(messageUrl);
    const pathParts = url.pathname.split('/').filter(part => part.length > 0);
    
    // Expected format: ['channels', 'GUILD_ID', 'CHANNEL_ID', 'MESSAGE_ID']
    if (pathParts.length >= 4 && pathParts[0] === 'channels') {
      const channelId = pathParts[2]; // This will be thread ID for threads, channel ID for regular channels
      const messageId = pathParts[3];
      
      if (channelId && messageId) {
        return { channelId, messageId };
      }
    }
    
    return null;
  } catch (error) {
    console.error('Error parsing message URL:', error);
    return null;
  }
}

// Enhanced function to start cleaning a message (supports all channel types)
async function startCleaning(messageUrl: string, channelId: string, messageId: string): Promise<{ success: boolean; error?: string; message?: Message }> {
  try {
    // Fetch the channel - this works for regular channels, threads, and forum posts
    const channel = await client.channels.fetch(channelId);
    
    if (!channel) {
      return { success: false, error: "Channel not found" };
    }

    // Check if it's a supported channel type
    let targetChannel: TextChannel | ThreadChannel;
    
    if (channel.type === ChannelType.GuildText || 
        channel.type === ChannelType.GuildAnnouncement ||
        channel.type === ChannelType.GuildVoice) {
      targetChannel = channel as TextChannel;
    } else if (channel.type === ChannelType.PublicThread || 
               channel.type === ChannelType.PrivateThread ||
               channel.type === ChannelType.AnnouncementThread) {
      targetChannel = channel as ThreadChannel;
    } else if (channel.type === ChannelType.GuildForum) {
      // For forum channels, the channelId should actually be a thread ID
      return { success: false, error: "Forum channel detected - please use the specific thread URL, not the forum channel URL" };
    } else {
      return { success: false, error: `Unsupported channel type: ${channel.type}` };
    }

    // Try to fetch the message
    let message: Message;
    try {
      message = await targetChannel.messages.fetch(messageId);
    } catch (fetchError) {
      console.error(`Failed to fetch message ${messageId} from channel ${channelId}:`, fetchError);
      return { success: false, error: "Message not found or bot lacks permission to access it" };
    }

    // Check if already cleaning
    if (cleaningTasks[messageUrl]) {
      return { success: false, error: "Already cleaning this message" };
    }

    // Start the cleaning interval
    cleaningTasks[messageUrl] = setInterval(async () => {
      try {
        await message.reactions.removeAll();
        console.log(`🧹 Cleaned reactions for message: ${messageUrl}`);
      } catch (cleanError) {
        console.error(`Error clearing reactions for ${messageUrl}:`, cleanError);
        // If we consistently fail to clean reactions, we might want to stop the task
        // For now, we'll just log the error and continue trying
      }
    }, 5000);

    console.log(`✅ Started cleaning reactions for: ${messageUrl} (Channel: ${targetChannel.name || 'Unknown'}, Type: ${targetChannel.type})`);
    return { success: true, message };

  } catch (error) {
    console.error(`Error in startCleaning for ${messageUrl}:`, error);
    return { success: false, error: String(error) };
  }
}

// Function to stop cleaning a message
function stopCleaning(messageUrl: string): boolean {
  if (cleaningTasks[messageUrl]) {
    clearInterval(cleaningTasks[messageUrl]);
    delete cleaningTasks[messageUrl];
    console.log(`🛑 Stopped cleaning reactions for: ${messageUrl}`);
    return true;
  }
  return false;
}

// Function to restore cleaning tasks from database on startup
async function restoreCleaningTasks() {
  const result = getAllMessages.all() as TrackedMessage[];
  
  console.log(`🔄 Restoring ${result.length} cleaning tasks from database...`);
  
  for (const row of result) {
    const startResult = await startCleaning(row.message_url, row.channel_id, row.message_id);
    if (startResult.success) {
      console.log(`✅ Restored cleaning for: ${row.message_url}`);
    } else {
      console.log(`❌ Failed to restore cleaning for: ${row.message_url} - ${startResult.error}`);
      // Remove from database if message/channel no longer exists
      deleteMessage.run(row.message_url);
    }
  }
}

const commands = [
  new SlashCommandBuilder()
    .setName("enable-reaction-cleaning")
    .setDescription("Start continuously removing reactions from messages (supports threads and forum posts).")
    .addStringOption((option) =>
      option
        .setName("message_url")
        .setDescription("Discord message URLs (space/comma separated) - works with regular channels, threads, and forum posts")
        .setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("disable-reaction-cleaning")
    .setDescription("Stop cleaning reactions from messages (supports threads and forum posts).")
    .addStringOption((option) =>
      option
        .setName("message_url")
        .setDescription("Discord message URLs (space/comma separated) - works with regular channels, threads, and forum posts")
        .setRequired(true)
    )
    .toJSON(),

  new SlashCommandBuilder()
    .setName("disable-all-cleaning")
    .setDescription("Stop cleaning reactions from ALL tracked messages.")
    .toJSON(),

  new SlashCommandBuilder()
    .setName("list-reaction-cleaning")
    .setDescription("Show all messages currently being cleaned.")
    .toJSON(),

  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check if the bot is responsive.")
    .toJSON(),

  new SlashCommandBuilder()
    .setName("source-code")
    .setDescription("Get the source code repository link for this bot.")
    .addBooleanOption((option) =>
      option
        .setName("ephemeral")
        .setDescription("Whether to show the response only to you (default: true)")
        .setRequired(false)
    )
    .toJSON(),
];

// Register slash commands function
async function registerCommands() {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN as string);
  const guildIds = (process.env.GUILD_IDS as string).split(",").map((id) => id.trim());
  const clientId = process.env.CLIENT_ID as string;

  try {
    console.log("🔄 Started refreshing application (/) commands.");
    
    for (const guildId of guildIds) {
      const data = await rest.put(
        Routes.applicationGuildCommands(clientId, guildId),
        { body: commands }
      ) as unknown[];
      
      console.log(`✅ Successfully reloaded ${data.length} application (/) commands for guild ${guildId}.`);
      console.log("📋 Registered commands:", (data as Array<{ name: string }>).map(cmd => cmd.name));
    }
  } catch (error) {
    console.error("❌ Error registering commands:", error);
  }
}

client.once("ready", async () => {
  console.log(`🤖 Logged in as ${client.user?.tag}`);
  
  // Register commands after bot is ready
  await registerCommands();
  
  // Restore cleaning tasks from database
  await restoreCleaningTasks();
  
  console.log("🚀 Bot is ready and all cleaning tasks have been restored!");
});

client.on("interactionCreate", async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const ephemeralReply = (content: string, ephemeral: boolean = true): InteractionReplyOptions => ({
    content,
    ephemeral,
  });

  try {
    if (interaction.commandName === "enable-reaction-cleaning") {
      const messageUrlsRaw = interaction.options.getString("message_url", true);
      
      // Accept multiple URLs separated by space, comma, or newline
      const urls = messageUrlsRaw
        .split(/[\s,\n]+/)
        .map((u) => u.trim())
        .filter((u) => u.length > 0);

      let started: string[] = [];
      let alreadyRunning: string[] = [];
      let invalid: string[] = [];
      let errors: string[] = [];

      for (const messageUrl of urls) {
        const parsed = parseMessageUrl(messageUrl);
        
        if (!parsed) {
          invalid.push(messageUrl);
          continue;
        }

        const { channelId, messageId } = parsed;
        const result = await startCleaning(messageUrl, channelId, messageId);
        
        if (result.success) {
          // Add to database
          try {
            const dbResult = insertMessage.run(messageUrl, channelId, messageId) as DatabaseRunResult;
            console.log(`✅ DB Insert successful for ${messageUrl}:`, dbResult);
            started.push(messageUrl);
          } catch (dbError) {
            console.error(`❌ DB Insert failed for ${messageUrl}:`, dbError);
            errors.push(`${messageUrl}: Database error - ${dbError}`);
            // Stop cleaning since we couldn't save it
            stopCleaning(messageUrl);
          }
        } else {
          if (result.error === "Already cleaning this message") {
            alreadyRunning.push(messageUrl);
          } else {
            errors.push(`${messageUrl}: ${result.error}`);
          }
        }
      }

      let reply = "";
      if (started.length)
        reply += `✅ **Started cleaning reactions for:**\n${started.map(url => `• ${url}`).join("\n")}\n\n`;
      if (alreadyRunning.length)
        reply += `🔄 **Already cleaning reactions for:**\n${alreadyRunning.map(url => `• ${url}`).join("\n")}\n\n`;
      if (invalid.length)
        reply += `❌ **Invalid message URLs:**\n${invalid.map(url => `• ${url}`).join("\n")}\n\n`;
      if (errors.length)
        reply += `⚠️ **Errors:**\n${errors.map(error => `• ${error}`).join("\n")}`;

      if (!reply) reply = "No valid message URLs provided.";

      await interaction.reply(ephemeralReply(reply.trim()));
    }
    else if (interaction.commandName === "disable-reaction-cleaning") {
      const messageUrlsRaw = interaction.options.getString("message_url", true);
      
      // Accept multiple URLs separated by space, comma, or newline
      const urls = messageUrlsRaw
        .split(/[\s,\n]+/)
        .map((u) => u.trim())
        .filter((u) => u.length > 0);

      if (urls.length === 0) {
        await interaction.reply(ephemeralReply("No message URL(s) provided."));
        return;
      }

      let stopped: string[] = [];
      let notRunning: string[] = [];
      let invalid: string[] = [];

      for (const url of urls) {
        const parsed = parseMessageUrl(url);
        
        if (!parsed) {
          invalid.push(url);
          continue;
        }
        
        if (stopCleaning(url)) {
          // Remove from database
          try {
            const dbResult = deleteMessage.run(url) as DatabaseRunResult;
            console.log(`✅ DB Delete successful for ${url}:`, dbResult);
            stopped.push(url);
          } catch (dbError) {
            console.error(`❌ DB Delete failed for ${url}:`, dbError);
            stopped.push(url); // Still consider it stopped from memory
          }
        } else {
          notRunning.push(url);
        }
      }

      let reply = "";
      if (stopped.length)
        reply += `🛑 **Stopped cleaning reactions for:**\n${stopped.map(url => `• ${url}`).join("\n")}\n\n`;
      if (notRunning.length)
        reply += `ℹ️ **No cleaning task was running for:**\n${notRunning.map(url => `• ${url}`).join("\n")}\n\n`;
      if (invalid.length)
        reply += `❌ **Invalid message URLs:**\n${invalid.map(url => `• ${url}`).join("\n")}`;

      if (!reply) reply = "No valid message URLs provided.";

      await interaction.reply(ephemeralReply(reply.trim()));
    }
    else if (interaction.commandName === "disable-all-cleaning") {
      const activeUrls = Object.keys(cleaningTasks);
      
      if (activeUrls.length === 0) {
        await interaction.reply(ephemeralReply("No messages are currently being cleaned."));
        return;
      }

      // Stop all cleaning tasks
      for (const url of activeUrls) {
        stopCleaning(url);
      }

      // Clear all from database
      try {
        const dbResult = clearAllMessages.run() as DatabaseRunResult;
        console.log(`✅ DB Clear all successful:`, dbResult);
        await interaction.reply(ephemeralReply(`🛑 Stopped cleaning reactions for all \`${activeUrls.length}\` message(s).`));
      } catch (dbError) {
        console.error(`❌ DB Clear all failed:`, dbError);
        await interaction.reply(ephemeralReply(`🛑 Failed to stop cleaning reactions for all \`${activeUrls.length}\` message(s). Warning: Database clear failed.`));
      }
    }
    else if (interaction.commandName === "list-reaction-cleaning") {
      const trackedMessages = getAllMessages.all() as TrackedMessage[];
      
      if (trackedMessages.length === 0) {
        await interaction.reply(ephemeralReply("No messages are currently being tracked for cleaning."));
        return;
      }

      const activeCount = Object.keys(cleaningTasks).length;
      let reply = `📋 **Tracked Messages** (${trackedMessages.length} total, ${activeCount} active):\n\n`;
      
      for (const row of trackedMessages) {
        const isActive = cleaningTasks[row.message_url] ? "🟢" : "🔴";
        const addedDate = new Date(row.added_at).toLocaleDateString();
        
        // Try to identify channel type from URL for better UX
        let channelInfo = "";
        const parsed = parseMessageUrl(row.message_url);
        if (parsed) {
          try {
            const channel = await client.channels.fetch(parsed.channelId);
            if (channel) {
              const channelTypeEmoji: Record<number, string> = {
                [ChannelType.GuildText]: "💬",
                [ChannelType.GuildAnnouncement]: "📢",
                [ChannelType.PublicThread]: "🧵",
                [ChannelType.PrivateThread]: "🔒🧵",
                [ChannelType.AnnouncementThread]: "📢🧵",
              };
              
              channelInfo = ` ${channelTypeEmoji[channel.type] || "❓"}`;
            }
          } catch (e) {
            // Ignore errors fetching channel info for display
          }
        }
        
        reply += `${isActive}${channelInfo} ${row.message_url} (added ${addedDate})\n`;
      }

      if (activeCount !== trackedMessages.length) {
        reply += `\n*🟢 = Active cleaning | 🔴 = Not running*\n*💬 = Text Channel | 📢 = Announcement | 🧵 = Thread | 🔒 = Private*`;
      }

      await interaction.reply(ephemeralReply(reply));
    }
    else if (interaction.commandName === "ping") {
      const start = Date.now();
      await interaction.reply(ephemeralReply("Pinging..."));
      const end = Date.now();
      
      await interaction.editReply({
        content: `🏓 Pong! Latency: ${end - start}ms | WebSocket: ${Math.round(client.ws.ping)}ms`
      });
    }
    else if (interaction.commandName === "source-code") {
      const isEphemeral = interaction.options.getBoolean("ephemeral") ?? true; // Default to true if not specified
      await interaction.reply(ephemeralReply("The source code for this bot can be found [here](<https://github.com/giralal/Reaction-Cleaner-Bot>)", isEphemeral));
    }

  } catch (error) {
    console.error("❌ Error handling interaction:", error);
    
    const errorReply = {
      content: "An error occurred while processing your command. Please check the bot's permissions and try again.",
      ephemeral: true
    };
    
    try {
      if (interaction.replied) {
        await interaction.followUp(errorReply);
      } else if (interaction.deferred) {
        await interaction.editReply(errorReply);
      } else {
        await interaction.reply(errorReply);
      }
    } catch (e) {
      console.error("❌ Error sending error reply:", e);
    }
  }
});

// Handle process termination gracefully
process.on('SIGINT', () => {
  console.log('🛑 Received SIGINT. Cleaning up...');
  
  // Stop all cleaning tasks
  Object.keys(cleaningTasks).forEach(url => stopCleaning(url));
  
  // Close database connection
  if (db) {
    db.close();
    console.log('🗄️ Database connection closed');
  }
  
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('🛑 Received SIGTERM. Cleaning up...');
  
  // Stop all cleaning tasks
  Object.keys(cleaningTasks).forEach(url => stopCleaning(url));
  
  // Close database connection
  if (db) {
    db.close();
    console.log('🗄️ Database connection closed');
  }
  
  process.exit(0);
});

client.login(process.env.DISCORD_TOKEN as string);