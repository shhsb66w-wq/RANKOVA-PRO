const { ownerOnlyMessage, assignRoleSecure, removeRoleSecure } = require('./role_security');
const { canCreateGame, waitingMessage } = require('./waiting_guard');
const { setupChecker, ensureCheckerSecurity } = require('./checker_security');
const { panel: supportPanel, handle: handleSupport } = require('./support_pro');

require('dotenv').config();
const {
  Client, GatewayIntentBits, Partials, ChannelType, PermissionsBitField,
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder,
  TextInputStyle, EmbedBuilder
} = require('discord.js');
const { PREFIX, MODES } = require('./config');
const store = require('./store');
const { missionsFor } = store;
const {
  setupServer, embed, leaderboardEmbed, profileEmbed, matchButtons,
  resultButtons, ensureRole, ensureCategory, ensureText, ensureVoice, BRAND,
  statsEmbed, rulesEmbed, missionEmbed
} = require('./helpers');

if (!process.env.DISCORD_TOKEN) {
  console.error('Missing DISCORD_TOKEN in .env');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Channel]
});

const matches = new Map();

const PLAY_CHANNELS = new Set(['🎮・rankova-play', '🎮・highlight-play']);
const CHANNEL_COMMANDS = {
  '🎮・profiles': new Set(['!ip','!profile','!rank','!ffid']),
  '📈・stats': new Set(['!stats']),
  '🎯・missions': new Set(['!missions']),
  '📜・rules-game': new Set(['!rules']),
  '🏆・rank・leaderboard': new Set(['!top','!rankings']),
  '📊・mvp-leaderboard': new Set(['!top','!rankings']),
  '🔥・win-streak': new Set(['!top','!rankings']),
  '🎮・rankova-play': new Set(['!play']),
  '🎮・highlight-play': new Set(['!play']),
};

function commandBase(content) {
  return content.trim().split(/\s+/)[0].toLowerCase();
}

async function assignGameRole(member, mode, guild) {
  const role = guild.roles.cache.find(r => r.name === `RANKOVA • ${mode.toUpperCase()} PLAYER`);
  if (role) await member.roles.add(role).catch(()=>{});
}

function channelGuard(msg, content) {
  const base = commandBase(content);
  if (!base.startsWith(PREFIX.toLowerCase())) return null;

  // Server administration is deliberately available only to staff/owner.
  if (content === `${PREFIX}rankova setup` || content === `${PREFIX}rankova server`) return null;

  // !play is ONLY accepted in the two competitive queue channels.
  if (base === `${PREFIX.toLowerCase()}play` && !PLAY_CHANNELS.has(msg.channel.name)) {
    return `❌ **Wrong channel.** Matchmaking is only available in <#${msg.guild.channels.cache.find(c => c.name === '🎮・rankova-play')?.id || msg.channel.id}> and <#${msg.guild.channels.cache.find(c => c.name === '🎮・highlight-play')?.id || msg.channel.id}>.`;
  }

  // Known commands have a single home. This stops users from running commands everywhere.
  const allowed = CHANNEL_COMMANDS[msg.channel.name];
  if (allowed && !allowed.has(base) && base.startsWith(PREFIX.toLowerCase())) {
    return `❌ **This channel has one job.** Use the correct RANKOVA channel for \`${base}\`.`;
  }

  // In all other public channels, block RANKOVA commands except setup/staff commands.
  if (!allowed && base.startsWith(PREFIX.toLowerCase())) {
    const known = ['play','ip','profile','rank','stats','missions','rules','top','rankings','ffid','report','check'];
    if (known.includes(base.slice(PREFIX.length))) return `❌ **RANKOVA command blocked here.** Please use the dedicated RANKOVA channel.`;
  }
  return null;
}


function isChecker(member) {
  return member.roles.cache.some(r =>
    r.name === 'RANKOVA • CHECKER' || r.name === 'RANKOVA • SENIOR CHECKER' ||
    r.name === 'RANKOVA • ASSISTANT'
  );
}

function makeId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
}

function parseMode(content) {
  const m = content.trim().toLowerCase().match(/^!play\s+(1v1|2v2|3v3|4v4)$/);
  return m ? m[1] : null;
}

async function refreshRoles(guild) {
  const lb = store.leaderboard();
  const names = [
    'RANKOVA • #1','RANKOVA • #2','RANKOVA • #3',
    'RANKOVA • TOP 5','RANKOVA • TOP 10','RANKOVA • TOP 20',
    'RANKOVA • TOP 50','RANKOVA • TOP 100'
  ];
  const roles = {};
  for (const n of names) roles[n] = guild.roles.cache.find(r => r.name === n);
  const all = await guild.members.fetch();
  for (const member of all.values()) {
    const p = lb.findIndex(x => x.id === member.id) + 1;
    const remove = Object.values(roles).filter(Boolean).filter(r => member.roles.cache.has(r.id));
    if (remove.length) await member.roles.remove(remove).catch(()=>{});
    const wanted = [];
    if (p === 1 && roles['RANKOVA • #1']) wanted.push(roles['RANKOVA • #1']);
    if (p === 2 && roles['RANKOVA • #2']) wanted.push(roles['RANKOVA • #2']);
    if (p === 3 && roles['RANKOVA • #3']) wanted.push(roles['RANKOVA • #3']);
    if (p <= 5 && roles['RANKOVA • TOP 5']) wanted.push(roles['RANKOVA • TOP 5']);
    if (p <= 10 && roles['RANKOVA • TOP 10']) wanted.push(roles['RANKOVA • TOP 10']);
    if (p <= 20 && roles['RANKOVA • TOP 20']) wanted.push(roles['RANKOVA • TOP 20']);
    if (p <= 50 && roles['RANKOVA • TOP 50']) wanted.push(roles['RANKOVA • TOP 50']);
    if (p <= 100 && roles['RANKOVA • TOP 100']) wanted.push(roles['RANKOVA • TOP 100']);
    if (wanted.length) await member.roles.add(wanted).catch(()=>{});
  }
}

async function updateLeaderboardChannel(guild) {
  const ch = guild.channels.cache.find(c => c.type === ChannelType.GuildText && c.name === '🏆・rank・leaderboard');
  if (!ch) return;
  const messages = await ch.messages.fetch({ limit: 20 }).catch(()=>null);
  if (messages) {
    const botMsg = messages.find(m => m.author.id === client.user.id && m.embeds[0]?.title?.includes('RANKOVA • LEADERBOARD'));
    if (botMsg) return botMsg.edit({ embeds: [leaderboardEmbed()] }).catch(()=>{});
  }
  await ch.send({ embeds: [leaderboardEmbed()] }).catch(()=>{});
}

async function createMatchChannel(guild, match) {
  const category = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name === '🎮 ─── RANKOVA • PARTY ─── 🎮');
  const everyone = guild.roles.everyone;
  const members = [...new Set([...match.team1, ...match.team2, match.host])];
  const overwrites = [
    { id: everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
    ...members.map(id => ({ id, allow: [
      PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.SendMessages,
      PermissionsBitField.Flags.ReadMessageHistory
    ]}))
  ];
  match.channel = await guild.channels.create({
    name: `match-${match.mode}-${match.id.slice(-5)}`,
    type: ChannelType.GuildText,
    parent: category?.id,
    permissionOverwrites: overwrites
  });
  const t1 = await guild.channels.create({
    name: `🔴・Team-1-${match.id.slice(-4)}`,
    type: ChannelType.GuildVoice, parent: category?.id,
    permissionOverwrites: [
      { id: everyone.id, deny: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect] },
      ...match.team1.map(id => ({ id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak] }))
    ]
  });
  const t2 = await guild.channels.create({
    name: `🟢・Team-2-${match.id.slice(-4)}`,
    type: ChannelType.GuildVoice, parent: category?.id,
    permissionOverwrites: [
      { id: everyone.id, deny: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect] },
      ...match.team2.map(id => ({ id, allow: [PermissionsBitField.Flags.ViewChannel, PermissionsBitField.Flags.Connect, PermissionsBitField.Flags.Speak] }))
    ]
  });
  match.voice1 = t1; match.voice2 = t2;
  const hostMember = await guild.members.fetch(match.host).catch(()=>null);
  if (hostMember) {
    await match.channel.send({
      embeds: [embed(`🎮 RANKOVA ${match.mode} • ROOM READY`,
        `🔴 **Team 1:** ${match.team1.map(x=>`<@${x}>`).join(', ')}\n` +
        `🟢 **Team 2:** ${match.team2.map(x=>`<@${x}>`).join(', ')}\n\n` +
        `👑 Host: <@${match.host}>\n\n` +
        `**Host:** click **Set Room** and enter the Room ID, optional password, optional private match key, and optional Team 1/Team 2 keys.

` +
        `If a team key is empty, that team requires **no key** to join.`      )],
      components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`room:${match.id}`).setLabel('🔐 Set Room').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`winner:${match.id}`).setLabel('🏁 Finish Match').setStyle(ButtonStyle.Secondary)
      )]
    });
  }
}

function lobbyEmbed(m) {
  const max = MODES[m.mode];
  return embed(`🎮 Free Fire ${m.mode} Match`,
    `**Match started by:** <@${m.host}>\n\n` +
    `🔴 **Team 1 (${m.team1.length}/${max})**\n${m.team1.map(x=>`<@${x}>`).join('\n') || 'Empty'}\n\n` +
    `🟢 **Team 2 (${m.team2.length}/${max})\n${m.team2.map(x=>`<@${x}>`).join('\n') || 'Empty'}\n\n` +
    `> When both teams are full, RANKOVA creates private team voices and a match room.`
  );
}

client.once('ready', async () => {
  console.log(`RANKOVA online as ${client.user.tag}`);
  store.ensureCurrentMonth();
  if (process.env.GUILD_ID) {
    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    if (guild) {
      try {
        await setupServer(guild);
        console.log('[RANKOVA] Server structure created/verified.');
      } catch (err) {
        console.error('[RANKOVA] Automatic server setup failed:', err);
      }
      await refreshRoles(guild).catch(err => console.error('[RANKOVA] Role refresh failed:', err));
      await updateLeaderboardChannel(guild).catch(err => console.error('[RANKOVA] Leaderboard update failed:', err));
    }
  }
});

client.on('messageCreate', async msg => {
  if (msg.author.bot || !msg.guild) return;
  const content = msg.content.trim();

  // RANKOVA role administration: SERVER OWNER ONLY.
  if (content.startsWith(`${PREFIX}giverole `)) {
    if (msg.guild.ownerId !== msg.author.id)
      return msg.reply(ownerOnlyMessage());

    const parts = content.split(/\s+/);
    const member = msg.mentions.members.first();
    const roleName = parts.slice(2).join(' ');
    const role = msg.guild.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase());
    if (!member || !role)
      return msg.reply(`❌ Usage: \`${PREFIX}giverole @player ROLE NAME\``);

    try {
      await member.roles.add(role, `RANKOVA owner role assignment by ${msg.author.tag}`);
      return msg.reply(`✅ ${role} given to ${member}.`);
    } catch (e) {
      return msg.reply(`❌ Could not give role: ${String(e.message).slice(0,500)}`);
    }
  }

  if (content.startsWith(`${PREFIX}removerole `)) {
    if (msg.guild.ownerId !== msg.author.id)
      return msg.reply(ownerOnlyMessage());

    const parts = content.split(/\s+/);
    const member = msg.mentions.members.first();
    const roleName = parts.slice(2).join(' ');
    const role = msg.guild.roles.cache.find(r => r.name.toLowerCase() === roleName.toLowerCase());
    if (!member || !role)
      return msg.reply(`❌ Usage: \`${PREFIX}removerole @player ROLE NAME\``);

    try {
      await member.roles.remove(role, `RANKOVA owner role removal by ${msg.author.tag}`);
      return msg.reply(`✅ ${role} removed from ${member}.`);
    } catch (e) {
      return msg.reply(`❌ Could not remove role: ${String(e.message).slice(0,500)}`);
    }
  }



  if (content === `${PREFIX}checker setup`) {
    return setupChecker(msg);
  }


  if (content === `${PREFIX}support`) return msg.channel.send(supportPanel());

  const guard = channelGuard(msg, content);
  if (guard) return msg.reply(guard);


  // The profile channel is intentionally simple: players use !ip to receive
  // their RANKOVA profile, rank, points and statistics.
  if (msg.channel.name === '🎮・profiles' && !content.startsWith(`${PREFIX}ip`)
      && !content.startsWith(`${PREFIX}profile`) && !content.startsWith(`${PREFIX}rank`)
      && !content.startsWith(`${PREFIX}ffid`) && !content.startsWith(`${PREFIX}rankova`)) {
    return msg.reply({
      embeds: [embed('👤 RANKOVA • PROFILE',
        `To see your **profile, rank, points, wins, losses, MVPs and streak**, use:\n\n` +
        `> **${PREFIX}ip**\n\n` +
        `🎮 To save your Free Fire ID, use:\n` +
        `> **${PREFIX}ffid YOUR_FREE_FIRE_ID**\n\n` +
        `Your Free Fire ID is displayed only on your RANKOVA profile.`)]
    });
  }

  if (content === `${PREFIX}rankova setup`) {
    if (!msg.member.permissions.has(PermissionsBitField.Flags.ManageGuild)) return msg.reply('❌ You need **Manage Server** to run setup.');
    try {
      await setupServer(msg.guild);
      await refreshRoles(msg.guild);
      await updateLeaderboardChannel(msg.guild);
    } catch (err) {
      console.error('[RANKOVA] Manual setup failed:', err);
      return msg.reply({ embeds: [embed('❌ RANKOVA SETUP FAILED',
        `RANKOVA could not create the server structure.

` +
        `**Most common cause:** the bot does not have **Manage Channels** and **Manage Roles**.

` +
        `Give the bot these permissions and run \`${PREFIX}rankova setup\` again.

` +
        `**Technical error:** \`${String(err.message || err).slice(0, 700)}\`` , 0xED4245)] });
    }

    const rules = msg.guild.channels.cache.find(c => c.name === '📜・rules-game');
    if (rules) {
      const recent = await rules.messages.fetch({ limit: 10 }).catch(()=>null);
      if (!recent?.some(m => m.author.id === client.user.id && m.embeds[0]?.title?.includes('OFFICIAL COMPETITIVE RULES'))) {
        await rules.send({ embeds: [rulesEmbed()] }).catch(()=>{});
      }
    }
    const tutorial = msg.guild.channels.cache.find(c => c.name === '🤖・bot-tutoriel');
    if (tutorial) {
      await tutorial.send({ embeds: [embed('🤖 RANKOVA • QUICK START',
        `**Play:** \`${PREFIX}play 1v1\`, \`${PREFIX}play 2v2\`, \`${PREFIX}play 3v3\`, \`${PREFIX}play 4v4\`
` +
        `**Profile:** \`${PREFIX}ip\`
**Stats:** \`${PREFIX}stats\`
**Missions:** \`${PREFIX}missions\`
` +
        `**Leaderboard:** \`${PREFIX}top\`
**Rules:** \`${PREFIX}rules\`

` +
        `When both teams are full, RANKOVA creates private team voice channels automatically.`)] }).catch(()=>{});
    }
    return msg.reply('✅ **RANKOVA PRO setup complete.** Competitive channels, checker area, support, history, elite roles and leaderboard are ready.');
  }

  if (content === `${PREFIX}rules`) {
    return msg.channel.send({ embeds: [rulesEmbed()] });
  }

  if (content === `${PREFIX}stats`) {
    return msg.channel.send({ embeds: [statsEmbed(msg.author)] });
  }

  if (content === `${PREFIX}missions`) {
    return msg.channel.send({ embeds: [missionEmbed(msg.author, missionsFor(msg.author.id))] });
  }

  if (content === `${PREFIX}top`) {
    const lb = store.leaderboard().slice(0, 20);
    const lines = lb.length
      ? lb.map((p, i) => `**${i+1}.** <@${p.id}> — ⭐ ${p.points.toLocaleString()} PTS • 🏆 ${p.wins}W • MVP ${p.mvpWins}`).join('\n')
      : 'No ranked players yet.';
    return msg.channel.send({ embeds: [embed('👑 RANKOVA • TOP 20', `**Season ${store.nowParts().season} • ${store.nowParts().year}**\n\n${lines}`)] });
  }

  if (content.startsWith(`${PREFIX}report `)) {
    const target = msg.mentions.users.first();
    if (!target) return msg.reply(`❌ Usage: \`${PREFIX}report @player reason\``);
    const reason = content.replace(`${PREFIX}report`, '').replace(/<@!?\\d+>/, '').trim();
    if (!reason) return msg.reply('❌ Please provide a reason.');
    const report = store.addReport({ reporterId: msg.author.id, targetId: target.id, reason });
    const reports = msg.guild.channels.cache.find(c => c.name === '🚨・reports');
    if (reports) await reports.send({ embeds: [embed('🚨 NEW PLAYER REPORT',
      `**Report:** \`${report.id}\`\n**Reporter:** <@${msg.author.id}>\n**Player:** <@${target.id}>\n**Reason:** ${reason}\n\nStatus: **OPEN**`, 0xED4245)] });
    return msg.reply(`✅ Report submitted to RANKOVA Checkers: **${report.id}**.`);
  }

  if (content.startsWith(`${PREFIX}check `)) {
    if (!isChecker(msg.member)) return msg.reply('❌ This command is for RANKOVA Checkers.');
    const target = msg.mentions.users.first();
    if (!target) return msg.reply(`❌ Usage: \`${PREFIX}check @player\``);
    const check = store.addCheck({ checkerId: msg.author.id, targetId: target.id, notes: 'Manual verification requested' });
    const ch = msg.guild.channels.cache.find(c => c.name === '🔎・checker');
    if (ch) await ch.send({ embeds: [embed('🛡️ PLAYER CHECK',
      `**Check:** \`${check.id}\`\n**Player:** <@${target.id}>\n**Checker:** <@${msg.author.id}>\n\nStatus: **PENDING**\n\nRequest evidence in the private checker area if required.`, 0x3498DB)] });
    return msg.reply(`🛡️ Check created: **${check.id}**.`);
  }

  const mode = parseMode(content);
  if (mode) {
    const id = makeId();
    const m = {
      id, guildId: msg.guild.id, mode, host: msg.author.id,
      team1: [msg.author.id], team2: [], teamKeys: {1:'',2:''}, privateKey:'',
      roomId:'', password:'', channel:null, voice1:null, voice2:null, lobbyChannelId:msg.channel.id
    };
    matches.set(id, m);
    await assignGameRole(msg.member, mode, msg.guild);
    const sent = await msg.channel.send({ embeds:[lobbyEmbed(m)], components:matchButtons(id, mode, m.team1, m.team2, false) });
    m.lobbyMessageId = sent.id;
    return;
  }

  // RANKOVA profile command.
  // In #profiles, !ip is the main command; !profile and !rank are aliases.
  if (content === `${PREFIX}ip` || content === `${PREFIX}profile` || content === `${PREFIX}rank`) {
    return msg.channel.send({ embeds: [profileEmbed(msg.author)] });
  }

  if (content.startsWith(`${PREFIX}ffid `)) {
    const ffid = content.slice(`${PREFIX}ffid `.length).trim();
    if (!/^\d{5,15}$/.test(ffid)) return msg.reply('❌ Free Fire ID must be numbers only (5–15 digits).');
    store.setFFID(msg.author.id, ffid, msg.author.username);
    return msg.reply('✅ Your Free Fire ID was saved. It is displayed only in your RANKOVA profile.');
  }

  if (content === `${PREFIX}rankings`) {
    return msg.channel.send({ embeds:[leaderboardEmbed()] });
  }
});

client.on('interactionCreate', async i => {
  if (!i.isButton() && !i.isModalSubmit()) return;
  const [action, id] = i.customId.split(':');
  const m = matches.get(id);
  if (!m) return i.reply({ content:'❌ This match no longer exists or has expired.', ephemeral:true });

  if (i.isButton() && ['join1','join2','leave','cancel'].includes(action)) {
    if (action === 'cancel') {
      if (i.user.id !== m.host) return i.reply({ content:'❌ Only the host can cancel this match.', ephemeral:true });
      matches.delete(id);
      if (m.channel) await m.channel.delete().catch(()=>{});
      if (m.voice1) await m.voice1.delete().catch(()=>{});
      if (m.voice2) await m.voice2.delete().catch(()=>{});
      return i.update({ embeds:[embed('🛑 Match Cancelled', 'The host cancelled this RANKOVA match.', 0xED4245)], components:[] });
    }
    if (action === 'leave') {
      m.team1 = m.team1.filter(x=>x!==i.user.id);
      m.team2 = m.team2.filter(x=>x!==i.user.id);
      const modeRole = i.guild.roles.cache.find(r => r.name === `RANKOVA • ${m.mode.toUpperCase()} PLAYER`);
      if (modeRole) await i.member.roles.remove(modeRole).catch(()=>{});
      return i.update({ embeds:[lobbyEmbed(m)], components:matchButtons(id,m.mode,m.team1,m.team2,false) });
    }
    const team = action === 'join1' ? 1 : 2;
    await assignGameRole(i.member, m.mode, i.guild);
    const arr = team === 1 ? m.team1 : m.team2;
    if (arr.includes(i.user.id)) return i.reply({content:'You are already in this team.',ephemeral:true});
    if (m.team1.includes(i.user.id) || m.team2.includes(i.user.id)) return i.reply({content:'❌ You are already in a team.',ephemeral:true});
    if (arr.length >= MODES[m.mode]) return i.reply({content:'❌ This team is full.',ephemeral:true});

    // If the host set a team key, ask for it; otherwise join immediately.
    if (m.teamKeys[team]) {
      const modal = new ModalBuilder().setCustomId(`teamkey:${id}:${team}`).setTitle(`Join Team ${team}`);
      const input = new TextInputBuilder().setCustomId('key').setLabel(`Team ${team} Key`).setPlaceholder('Enter the team key').setStyle(TextInputStyle.Short).setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(input));
      return i.showModal(modal);
    }
    arr.push(i.user.id);
    await i.update({ embeds:[lobbyEmbed(m)], components:matchButtons(id,m.mode,m.team1,m.team2,false) });
    if (m.team1.length === MODES[m.mode] && m.team2.length === MODES[m.mode]) {
      await createMatchChannel(i.guild, m);
    }
    return;
  }

  if (i.isModalSubmit() && action === 'teamkey') {
    const team = Number(i.customId.split(':')[2]);
    if (i.fields.getTextInputValue('key') !== m.teamKeys[team]) return i.reply({content:'❌ Wrong team key.',ephemeral:true});
    const arr = team===1 ? m.team1 : m.team2;
    if (arr.length >= MODES[m.mode]) return i.reply({content:'❌ This team is full.',ephemeral:true});
    arr.push(i.user.id);
    await i.reply({content:`✅ You joined Team ${team}.`,ephemeral:true});
    const lobby = await i.guild.channels.cache.get(m.lobbyChannelId)?.messages.fetch(m.lobbyMessageId).catch(()=>null);
    if (lobby) await lobby.edit({embeds:[lobbyEmbed(m)],components:matchButtons(id,m.mode,m.team1,m.team2,false)});
    if (m.team1.length === MODES[m.mode] && m.team2.length === MODES[m.mode]) await createMatchChannel(i.guild,m);
    return;
  }

  if (i.isButton() && action === 'room') {
    if (i.user.id !== m.host) return i.reply({content:'❌ Only the host can set room information.',ephemeral:true});
    const modal = new ModalBuilder().setCustomId(`roommodal:${id}`).setTitle('RANKOVA • Enter Room Information');
    const room = new TextInputBuilder().setCustomId('room').setLabel('Room ID (Numbers Only)').setPlaceholder('Enter the game room ID').setStyle(TextInputStyle.Short).setRequired(true);
    const pass = new TextInputBuilder().setCustomId('pass').setLabel('Password (Optional)').setPlaceholder('Enter room password if any').setStyle(TextInputStyle.Short).setRequired(false);
    const pkey = new TextInputBuilder().setCustomId('pkey').setLabel('Private Match Key (Optional)').setPlaceholder('Players must enter this key to join').setStyle(TextInputStyle.Short).setRequired(false);
    const k1 = new TextInputBuilder().setCustomId('key1').setLabel('Team 1 Key (Optional)').setPlaceholder('Leave empty for no Team 1 key').setStyle(TextInputStyle.Short).setRequired(false);
    const k2 = new TextInputBuilder().setCustomId('key2').setLabel('Team 2 Key (Optional)').setPlaceholder('Leave empty for no Team 2 key').setStyle(TextInputStyle.Short).setRequired(false);
    modal.addComponents(
      new ActionRowBuilder().addComponents(room),
      new ActionRowBuilder().addComponents(pass),
      new ActionRowBuilder().addComponents(pkey),
      new ActionRowBuilder().addComponents(k1),
      new ActionRowBuilder().addComponents(k2)
    );
    return i.showModal(modal);
  }

  if (i.isModalSubmit() && action === 'roommodal') {
    if (i.user.id !== m.host) return i.reply({content:'❌ Only the host can set room information.',ephemeral:true});
    const room = i.fields.getTextInputValue('room').trim();
    if (!/^\d+$/.test(room)) return i.reply({content:'❌ Room ID must contain numbers only.',ephemeral:true});
    m.roomId = room;
    m.password = i.fields.getTextInputValue('pass').trim();
    m.privateKey = i.fields.getTextInputValue('pkey').trim();
    m.teamKeys[1] = i.fields.getTextInputValue('key1').trim();
    m.teamKeys[2] = i.fields.getTextInputValue('key2').trim();

    const keyLine = m.privateKey ? '🔐 **Private Match Key:** Set' : '🔓 **Private Match Key:** None';
    await i.reply({content:'✅ Room information saved. It is visible only to match participants in the private match channel.',ephemeral:true});
    if (m.channel) await m.channel.send({
      embeds:[embed('🔐 ROOM INFORMATION',
        `🎮 **Room ID:** \`${m.roomId}\`\n` +
        `🔑 **Password:** \`${m.password || 'None'}\`\n` +
        `${keyLine}\n\n` +
        `🔴 Team 1 Key: ${m.teamKeys[1] ? 'Set' : 'None'}\n` +
        `🟢 Team 2 Key: ${m.teamKeys[2] ? 'Set' : 'None'}\n\n` +
        `> Never share this room information outside the match.`
      )]
    });
    return;
  }

  if (i.isButton() && (action === 'winner' || action === 'winner1' || action === 'winner2')) {
    if (i.user.id !== m.host) return i.reply({content:'❌ Only the match host can finish the match.',ephemeral:true});
    if (action === 'winner') return i.reply({content:'Choose the winning team below.',components:resultButtons(id),ephemeral:true});
    m.winner = action === 'winner1' ? 1 : 2;
    const win = m.winner === 1 ? m.team1 : m.team2;
    const lose = m.winner === 1 ? m.team2 : m.team1;
    const row = new ActionRowBuilder();
    for (const uid of win) row.addComponents(new ButtonBuilder().setCustomId(`mvpw:${id}:${uid}`).setLabel(`⭐ ${i.guild.members.cache.get(uid)?.displayName || 'Winner'}`).setStyle(ButtonStyle.Primary));
    const row2 = new ActionRowBuilder();
    for (const uid of lose) row2.addComponents(new ButtonBuilder().setCustomId(`mvpl:${id}:${uid}`).setLabel(`💥 ${i.guild.members.cache.get(uid)?.displayName || 'Loser'}`).setStyle(ButtonStyle.Secondary));
    return i.reply({content:'⭐ Select **MVP Winner** and **MVP Loser**. Click one button in each section.',components:[row,row2],ephemeral:true});
  }

  if (i.isButton() && (action === 'mvpw' || action === 'mvpl')) {
    if (i.user.id !== m.host) return i.reply({content:'❌ Only the match host can select MVPs.',ephemeral:true});
    const parts = i.customId.split(':');
    const uid = parts[2];
    if (!uid) return i.reply({content:'❌ Invalid MVP selection.',ephemeral:true});
    if (action === 'mvpw') m.mvpWinner = uid;
    else m.mvpLoser = uid;
    if (!m.mvpWinner || !m.mvpLoser) return i.reply({content:`✅ ${action==='mvpw'?'MVP Winner':'MVP Loser'} selected. Now select the other MVP.`,ephemeral:true});

    const winners = m.winner === 1 ? m.team1 : m.team2;
    const losers = m.winner === 1 ? m.team2 : m.team1;
    for (const uid2 of winners) store.addResult(uid2, i.guild.members.cache.get(uid2)?.user.username || 'Player', true, uid2===m.mvpWinner, m.mode);
    for (const uid2 of losers) store.addResult(uid2, i.guild.members.cache.get(uid2)?.user.username || 'Player', false, uid2===m.mvpLoser, m.mode);
    store.db.matches.push({
      id:m.id, mode:m.mode, guildId:m.guildId, host:m.host, team1:m.team1, team2:m.team2,
      winner:m.winner, mvpWinner:m.mvpWinner, mvpLoser:m.mvpLoser, roomId:m.roomId,
      completedAt:Date.now()
    });
    store.save();
    await refreshRoles(i.guild);
    await updateLeaderboardChannel(i.guild);
    const result = embed('🏆 MATCH COMPLETE',
      `🔴 **Team 1:** ${m.winner===1?'🏆 VICTORY':'❌ DEFEAT'}\n` +
      `🟢 **Team 2:** ${m.winner===2?'🏆 VICTORY':'❌ DEFEAT'}\n\n` +
      `⭐ **MVP Winner:** <@${m.mvpWinner}>\n💥 **MVP Loser:** <@${m.mvpLoser}>\n\n` +
      `🎮 **Room ID:** \`${m.roomId || 'Not entered'}\`\n🔑 **Password:** \`${m.password || 'None'}\``
    );
    await i.update({content:'',embeds:[result],components:[]});
    if (m.channel) {
      await m.channel.send({embeds:[result]});
      setTimeout(()=>m.channel?.delete().catch(()=>{}), 15000);
    }
    setTimeout(()=>m.voice1?.delete().catch(()=>{}), 5000);
    setTimeout(()=>m.voice2?.delete().catch(()=>{}), 5000);
    matches.delete(id);
  }
});


client.on('interactionCreate', async interaction => {
  if (interaction.isButton() || interaction.isModalSubmit()) await handleSupport(interaction).catch(()=>{});
});

client.once('ready', async () => {
  for (const guild of client.guilds.cache.values()) {
    await ensureCheckerSecurity(guild).catch(err => console.error('Checker security setup:', err.message));
  }
});

client.login(process.env.DISCORD_TOKEN);
