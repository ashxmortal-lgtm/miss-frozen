/**
 * Central command metadata for dynamic help / welcome lists.
 * access: 'user' | 'admin' | 'owner'
 */
export const COMMANDS = [
  { cmd: '/start', desc: 'Start the bot', access: 'user' },
  { cmd: '/help', desc: 'Command list', access: 'user' },
  { cmd: '/claim', desc: 'Daily claim (DM; alias /daily)', access: 'user' },
  { cmd: '/balance', desc: 'Check balance, rank & chakra', access: 'user' },
  { cmd: '/profile', desc: 'Your rank, XP, roster & stats', access: 'user' },
  { cmd: '/inventory', desc: 'Your items', access: 'user' },
  { cmd: '/shinobi_store', desc: 'Unlock jutsu & items', access: 'user' },
  { cmd: '/buy', desc: 'Buy items / chakra (min 100 chakra, 2 🍥 each)', access: 'user' },
  { cmd: '/mission', desc: 'Start a mission (group)', access: 'user' },
  { cmd: '/patrol', desc: 'Start a patrol (group)', access: 'user' },
  { cmd: '/map', desc: 'Konoha village map (missions, BBQ, Ichiraku, …)', access: 'user' },
  { cmd: '/ability', desc: 'Your abilities (alias /abilities)', access: 'user' },
  { cmd: '/mt', desc: 'Mind Transmission — reply in group (requires jutsu)', access: 'user' },
  { cmd: '/gift_store', desc: "Ino's Gift Store catalog", access: 'user' },
  { cmd: '/gift', desc: 'Send a gift — reply to user then /gift number', access: 'user' },
  { cmd: '/hug', desc: 'Hug someone (reply in group)', access: 'user' },
  { cmd: '/slap', desc: 'Slap someone (reply in group)', access: 'user' },
  { cmd: '/punch', desc: 'Punch someone (reply in group)', access: 'user' },
  { cmd: '/pat', desc: 'Pat someone (reply in group)', access: 'user' },
  { cmd: '/kill', desc: 'Kill a target', access: 'user' },
  { cmd: '/rob', desc: 'Rob a target', access: 'user' },
  { cmd: '/protect', desc: 'Activate protection', access: 'user' },
  { cmd: '/byakugan', desc: 'Check protection status', access: 'user' },
  { cmd: '/search_tsuna', desc: 'Search for Tsunade', access: 'user' },
  { cmd: '/games', desc: 'Games hub', access: 'user' },
  { cmd: '/xoxo', desc: 'Tic-tac-toe lobby (group)', access: 'user' },
  { cmd: '/xoxo_stats', desc: 'Your XOXO stats', access: 'user' },
  { cmd: '/rps', desc: 'Rock-paper-scissors lobby (group)', access: 'user' },
  { cmd: '/rps_stats', desc: 'Your RPS stats', access: 'user' },
  { cmd: '/transfer', desc: 'Transfer coins to a user (reply in group)', access: 'user' },
  { cmd: '/leaderboard', desc: 'Top balances (alias /lb)', access: 'user' },
  { cmd: '/lb', desc: 'Top balances (alias /leaderboard)', access: 'user' },
  { cmd: '/equip', desc: 'Equip a shinobi (max 3)', access: 'user' },
  { cmd: '/unequip', desc: 'Unequip a shinobi', access: 'user' },
  { cmd: '/redeem', desc: 'Redeem a coupon code', access: 'user' },
  { cmd: '/owner', desc: 'Contact the owner (alias /awwsheesh)', access: 'user' },
  { cmd: '/eco', desc: 'Lock/unlock economy in this group (/eco on|off) — group admins', access: 'admin' },
  { cmd: '/stats', desc: 'Bot usage statistics', access: 'owner' },
  { cmd: '/groups', desc: 'List groups the bot is in (alias /approved_list)', access: 'owner' },
  { cmd: '/ow_announce', desc: 'Owner broadcast to groups/DMs', access: 'owner' },
  { cmd: '/addcoins', desc: 'Add coins to a user', access: 'owner' },
  { cmd: '/backup', desc: 'Database backup', access: 'owner' },
  { cmd: '/backup_all', desc: 'Full source + project snapshot backup', access: 'owner' },
  { cmd: '/create_cc', desc: 'Create a coupon code', access: 'owner' },
  { cmd: '/list_cc', desc: 'List active coupon codes', access: 'owner' },
  { cmd: '/edit_cc', desc: 'Edit a coupon code', access: 'owner' },
];

export function listCommands(accessFilter) {
  if (accessFilter === 'user') return COMMANDS.filter((c) => c.access === 'user');
  if (accessFilter === 'admin') return COMMANDS.filter((c) => c.access === 'user' || c.access === 'admin');
  if (accessFilter === 'owner') return COMMANDS.filter((c) => c.access === 'owner' || c.access === 'admin');
  return COMMANDS.filter((c) => c.access === 'user');
}

export function formatCommandList(cmds) {
  return cmds.map((c) => `${c.cmd} — ${c.desc}`).join('\n');
}
