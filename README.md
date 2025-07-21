# Discord Reaction Manager Bot

Do you have a niche scenario and need a bot to remove reactions from a certain message? This bot does exactly that.

## Main Features

### Commands

> `enable-reaction-cleaning` - takes discord message url inputs and starts reoccuring cleaning of reactions from the message(s)

> `list-reaction-cleaning` - lists the messages currently being tracked for cleaning

> `disable-reaction-cleaning` - takes discord message url inputs and stops reoccuring cleaning of reactions from the message(s)

> `disable-all-cleaning` - stops all reaction cleaning

-# more commands may come but this should be most of the needed functionality already

## Installation

This bot uses Docker. If you need to know how to install and set up Docker refer to the [Docker Docs](https://docs.docker.com/engine/install/) I also recommend not running docker as a non root user which you can find instructions for [here](https://docs.docker.com/engine/install/linux-postinstall/)

> [!IMPORTANT]
> This Guide is for running the bot using Docker. If you wish to run the bot any other way, you are on your own.

1. Down the Source Code

   > ` git clone https://github.com/giralal/Reaction-Cleaner-Bot`

2. Navigate to the bot's directory

   > ` cd Reaction-Cleaner-Bot`

3. Make a copy of .envexample simply as .env

   > ` cp .envexample .env`

4. Fill in .env

> Make sure your bot in the Discord Developer Portal has the correct intents and it has the correct permissions in the server(s)

5. Starting the bot

> `docker compose up -d --build`
> you will need to run this everytime you edit the source code for your changes to update

5.1 Stopping the bot

> If you need to stop the bot
> `docker compose down`
> To start it without rebuilding
> ` docker compose up -d`
