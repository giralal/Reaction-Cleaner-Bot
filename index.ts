import "dotenv/config";
import {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  SlashCommandBuilder,
  TextChannel,
  Message,
  InteractionReplyOptions,
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
      mkdirSync(dataDir, { recursive: true, mode: 0o755 });
      console.log('✅ Data directory created successfully');
    } catch (error) {
      console.error('❌ Failed to create data directory:', error);
      throw new Error(`Cannot create data directory: ${dataDir}`);
    }
  } else {
    console.log('✅ Data directory already exists');
  }
  
  // Check database file (SQLite will create it automatically if it doesn't exist)
  if (!existsSync(dbPath)) {
    console.log(`🗄️ Database file doesn't exist. It will be created: ${dbPath}`);
  } else {
    console.log('✅ Database file already exists');
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

// Prepared statements for better performance
const insertMessage = db.prepare("INSERT OR IGNORE INTO tracked_messages (message_url, channel_id, message_id) VALUES (?, ?, ?)");
const deleteMessage = db.prepare("DELETE FROM tracked_messages WHERE message_url = ?");
const getAllMessages = db.prepare("SELECT * FROM tracked_messages");
const clearAllMessages = db.prepare("DELETE FROM tracked_messages");

// Test database connection and log initial state
console.log("🧪 Testing database connection...");
try {
  const testQuery = db.prepare("SELECT COUNT(*) as count FROM tracked_messages").get() as { count: number };
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

// Function to start cleaning a message
async function startCleaning(messageUrl: string, channelId: string, messageId: string): Promise<{ success: boolean; error?: string; message?: Message }> {
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel || !(channel instanceof TextChannel)) {
      return { success: false, error: "Channel not found or is not a text channel" };
    }

    let message: Message;
    try {
      message = await channel.messages.fetch(messageId);
    } catch {
      return { success: false, error: "Message not found" };
    }

    if (cleaningTasks[messageUrl]) {
      return { success: false, error: "Already cleaning this message" };
    }

    cleaningTasks[messageUrl] = setInterval(async () => {
      try {
        await message.reactions.removeAll();
      } catch (e) {
        console.error("Error clearing reactions:", e);
      }
    }, 5000);

    return { success: true, message };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

// Function to stop cleaning a message
function stopCleaning(messageUrl: string): boolean {
  if (cleaningTasks[messageUrl]) {
    clearInterval(cleaningTasks[messageUrl]);
    delete cleaningTasks[messageUrl];
    return true;
  }
  return false;
}

// Function to restore cleaning tasks from database on startup
async function restoreCleaningTasks() {
  const trackedMessages = getAllMessages.all() as Array<{ message_url: string; channel_id: string; message_id: string }>;
  
  console.log(`🔄 Restoring ${trackedMessages.length} cleaning tasks from database...`);
  
  for (const row of trackedMessages) {
    const result = await startCleaning(row.message_url, row.channel_id, row.message_id);
    if (result.success) {
      console.log(`✅ Restored cleaning for: ${row.message_url}`);
    } else {
      console.log(`❌ Failed to restore cleaning for: ${row.message_url} - ${result.error}`);
      // Remove from database if message/channel no longer exists
      deleteMessage.run(row.message_url);
    }
  }
}

const commands = [
  new SlashCommandBuilder()
    .setName("enable-reaction-cleaning")
    .setDescription("Start continuously removing reactions from messages.")
    .addStringOption((option) =>
      option
        .setName("message_url")
        .setDescription("Discord message URLs (space/comma separated)")
        .setRequired(true)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName("disable-reaction-cleaning")
    .setDescription("Stop cleaning reactions from messages.")
    .addStringOption((option) =>
      option
        .setName("message_url")
        .setDescription("Discord message URLs (space/comma separated)")
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
      ) as any[];
      
      console.log(`✅ Successfully reloaded ${data.length} application (/) commands for guild ${guildId}.`);
      console.log("📋 Registered commands:", data.map(cmd => cmd.name));
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

  const ephemeralReply = (content: string): InteractionReplyOptions => ({
    content,
    ephemeral: true,
  });

  try {
    if (interaction.commandName === "enable-reaction-cleaning") {
      const messageUrlsRaw = interaction.options.getString("message_url", true);

      // Accept multiple URLs separated by space, comma, or newline
      const urls = messageUrlsRaw
        .split(/[\s,]+/)
        .map((u) => u.trim())
        .filter((u) => u.length > 0);

      let started: string[] = [];
      let alreadyRunning: string[] = [];
      let invalid: string[] = [];
      let errors: string[] = [];

      for (const messageUrl of urls) {
        const parts = messageUrl.split("/");
        if (parts.length < 3) {
          invalid.push(messageUrl);
          continue;
        }
        
        const channelId = parts[parts.length - 2];
        const messageId = parts[parts.length - 1];

        const result = await startCleaning(messageUrl, channelId, messageId);
        
        if (result.success) {
          if (result.error === "Already cleaning this message") {
            alreadyRunning.push(messageUrl);
          } else {
            // Add to database
            try {
              const dbResult = insertMessage.run(messageUrl, channelId, messageId);
              console.log(`✅ DB Insert successful for ${messageUrl}:`, dbResult);
              started.push(messageUrl);
            } catch (dbError) {
              console.error(`❌ DB Insert failed for ${messageUrl}:`, dbError);
              errors.push(`${messageUrl}: Database error - ${dbError}`);
              // Stop cleaning since we couldn't save it
              stopCleaning(messageUrl);
            }
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
        reply += `Started cleaning reactions for:\n${started.map(url => `• ${url}`).join("\n")}\n\n`;
      if (alreadyRunning.length)
        reply += `Already cleaning reactions for:\n${alreadyRunning.map(url => `• ${url}`).join("\n")}\n\n`;
      if (invalid.length)
        reply += `Invalid message URLs:\n${invalid.map(url => `• ${url}`).join("\n")}\n\n`;
      if (errors.length)
        reply += `Errors:\n${errors.map(error => `• ${error}`).join("\n")}`;

      if (!reply) reply = "No valid message URLs provided.";

      await interaction.reply(ephemeralReply(reply.trim()));
    }

    else if (interaction.commandName === "disable-reaction-cleaning") {
      const messageUrlsRaw = interaction.options.getString("message_url", true);

      // Accept multiple URLs separated by space, comma, or newline
      const urls = messageUrlsRaw
        .split(/[\s,]+/)
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
        const parts = url.split("/");
        if (parts.length < 3) {
          invalid.push(url);
          continue;
        }
        
        if (stopCleaning(url)) {
          // Remove from database
          try {
            const dbResult = deleteMessage.run(url);
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
        reply += `Stopped cleaning reactions for:\n${stopped.map(url => `• ${url}`).join("\n")}\n\n`;
      if (notRunning.length)
        reply += `No cleaning task was running for:\n${notRunning.map(url => `• ${url}`).join("\n")}\n\n`;
      if (invalid.length)
        reply += `Invalid message URLs:\n${invalid.map(url => `• ${url}`).join("\n")}`;

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
        const dbResult = clearAllMessages.run();
        console.log(`✅ DB Clear all successful:`, dbResult);
        await interaction.reply(ephemeralReply(`🛑 Stopped cleaning reactions for all \`${activeUrls.length}\` message(s).`));
      } catch (dbError) {
        console.error(`❌ DB Clear all failed:`, dbError);
        await interaction.reply(ephemeralReply(`🛑 Failed to stop cleaning reactions for all \`${activeUrls.length}\` message(s). Warning: Database clear failed.`));
      }
    }

    else if (interaction.commandName === "list-reaction-cleaning") {
      const trackedMessages = getAllMessages.all() as Array<{ message_url: string; added_at: string }>;
      
      if (trackedMessages.length === 0) {
        await interaction.reply(ephemeralReply("No messages are currently being tracked for cleaning."));
        return;
      }

      const activeCount = Object.keys(cleaningTasks).length;
      let reply = `📋 **Tracked Messages** (${trackedMessages.length} total, ${activeCount} active):\n\n`;
      
      for (const row of trackedMessages) {
        const isActive = cleaningTasks[row.message_url] ? "🟢" : "🔴";
        const addedDate = new Date(row.added_at).toLocaleDateString();
        reply += `${isActive} ${row.message_url} *(added ${addedDate})*\n`;
      }

      if (activeCount !== trackedMessages.length) {
        reply += `\n*🟢 = Active cleaning | 🔴 = Not running (bot was restarted/error)*`;
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