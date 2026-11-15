#!/usr/bin/env node

const readline = require('readline');
const path = require('path');
const fs = require('fs');

// Resolve dependencies from extra_files/node_modules if moved
const extraModules = path.join(__dirname, 'extra_files', 'node_modules');
if (fs.existsSync(extraModules) && !module.paths.includes(extraModules)) {
  module.paths.unshift(extraModules);
}

try { require('dotenv').config(); } catch(e) {}

let dbModule = null;
try {
  dbModule = require('./src/db');
} catch (e) {
  console.warn('⚠️ Could not load src/db:', e.message);
}

// Execute query via src/db (supports external Neon Cloud PostgreSQL & embedded PGlite)
async function runQuery(sql) {
  if (!dbModule) {
    return { success: false, error: 'Database module src/db not available' };
  }
  try {
    const res = await dbModule.query(sql);
    return {
      success: true,
      command: res.command,
      rowCount: res.rowCount !== undefined ? res.rowCount : (res.rows ? res.rows.length : 0),
      rows: res.rows || [],
      fields: res.fields ? res.fields.map(f => (typeof f === 'string' ? f : f.name)) : (res.rows && res.rows[0] ? Object.keys(res.rows[0]) : [])
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// Format rows into a clean terminal table
function printTable(rows, fields) {
  if (!rows || rows.length === 0) {
    console.log('(0 rows)\n');
    return;
  }

  const cols = fields && fields.length > 0 ? fields : Object.keys(rows[0]);

  // Calculate column widths
  const widths = {};
  for (const c of cols) {
    widths[c] = String(c).length;
  }
  for (const row of rows) {
    for (const c of cols) {
      const valStr = row[c] === null || row[c] === undefined ? 'NULL' : String(row[c]);
      if (valStr.length > widths[c]) {
        widths[c] = Math.min(50, Math.max(widths[c], valStr.length));
      }
    }
  }

  // Header line
  const header = cols.map(c => String(c).padEnd(widths[c])).join(' | ');
  const sep = cols.map(c => '-'.repeat(widths[c])).join('-+-');

  console.log(header);
  console.log(sep);

  for (const row of rows) {
    const line = cols.map(c => {
      let valStr = row[c] === null || row[c] === undefined ? 'NULL' : String(row[c]);
      if (valStr.length > widths[c]) {
        valStr = valStr.substring(0, widths[c] - 3) + '...';
      }
      return valStr.padEnd(widths[c]);
    }).join(' | ');
    console.log(line);
  }

  console.log(`\n(${rows.length} row${rows.length === 1 ? '' : 's'})\n`);
}

// Process meta-commands
async function handleMetaCommand(cmd) {
  const trimmed = cmd.trim();

  if (trimmed === '\\q' || trimmed === 'exit' || trimmed === 'quit') {
    console.log('Bye!');
    process.exit(0);
  }

  if (trimmed === 'help' || trimmed === '\\?') {
    console.log('\nAvailable Commands:');
    console.log('  \\b or \\bookings          Show latest 10 train bookings');
    console.log('  \\p or \\passengers        Show latest 15 passengers (PID & Status)');
    console.log('  \\i or \\inventory         Show real-time seat inventory for trains');
    console.log('  \\r or \\refunds           Show latest racing condition refunds');
    console.log('  \\h or \\hotels            Show latest hotel bookings');
    console.log('  \\f or \\flights           Show latest flight bookings');
    console.log('  \\bus or \\buses           Show latest bus bookings');
    console.log('  \\dt or .tables           List all tables in database');
    console.log('  \\d <table_name>          Show columns/schema of table');
    console.log('  \\sync                    Backup/sync cloud database to local storage');
    console.log('  \\q or exit               Exit interactive terminal');
    console.log('  SELECT ...;              Execute any standard SQL query on live cloud DB\n');
    return true;
  }

  if (trimmed === '\\b' || trimmed === '\\bookings') {
    console.log('\n--- 🎫 Latest Train Bookings (Cloud PostgreSQL) ---');
    const res = await runQuery('SELECT id, pnr, ticket_pid, train_no, journey_date, class_code, status, total_fare, booked_at FROM bookings ORDER BY id DESC LIMIT 10;');
    if (res.success) printTable(res.rows, res.fields);
    else console.error('Error:', res.error);
    return true;
  }

  if (trimmed === '\\p' || trimmed === '\\passengers') {
    console.log('\n--- 👤 Latest Passenger Details (OS Threads & PIDs) ---');
    const res = await runQuery('SELECT id, pnr, pax_name, age, gender, coach, berth_no, status FROM passengers ORDER BY id DESC LIMIT 15;');
    if (res.success) printTable(res.rows, res.fields);
    else console.error('Error:', res.error);
    return true;
  }

  if (trimmed === '\\i' || trimmed === '\\inventory') {
    console.log('\n--- 📊 Train Seat Inventory (Live Concurrency Tracker) ---');
    const res = await runQuery('SELECT train_no, journey_date, class_code, quota, available_seats, booked_seats, wl_count FROM seat_inventory ORDER BY id DESC LIMIT 10;');
    if (res.success) printTable(res.rows, res.fields);
    else console.error('Error:', res.error);
    return true;
  }

  if (trimmed === '\\r' || trimmed === '\\refunds') {
    console.log('\n--- 💰 Refund Records (Automated Racing Condition Resolution) ---');
    const res = await runQuery('SELECT id, pnr, refund_ref, amount, status, reason, payment_method FROM refunds ORDER BY id DESC LIMIT 10;');
    if (res.success) printTable(res.rows, res.fields);
    else console.error('Error:', res.error);
    return true;
  }

  if (trimmed === '\\h' || trimmed === '\\hotels') {
    console.log('\n--- 🏨 Hotel Bookings ---');
    const res = await runQuery('SELECT id, city, hotel_name, check_in, check_out, guests, total_price, status FROM hotel_bookings ORDER BY id DESC LIMIT 10;');
    if (res.success) printTable(res.rows, res.fields);
    else console.error('Error:', res.error);
    return true;
  }

  if (trimmed === '\\f' || trimmed === '\\flights') {
    console.log('\n--- ✈️ Flight Bookings ---');
    const res = await runQuery('SELECT id, pnr, flight_no, airline, from_city, to_city, journey_date, status, total_fare FROM flight_bookings ORDER BY id DESC LIMIT 10;');
    if (res.success) printTable(res.rows, res.fields);
    else console.error('Error:', res.error);
    return true;
  }

  if (trimmed === '\\bus' || trimmed === '\\buses') {
    console.log('\n--- 🚌 Bus Bookings ---');
    const res = await runQuery('SELECT id, pnr, bus_name, bus_type, from_city, to_city, journey_date, status, total_fare FROM bus_bookings ORDER BY id DESC LIMIT 10;');
    if (res.success) printTable(res.rows, res.fields);
    else console.error('Error:', res.error);
    return true;
  }

  if (trimmed === '\\sync') {
    console.log('\n⏳ Syncing live cloud database to local offline backup...');
    try {
      require('./sync_db');
    } catch(e) {
      console.log('Run "node sync_db.js" to initiate full offline replication.');
    }
    return true;
  }

  if (trimmed === '\\dt' || trimmed === '.tables') {
    const sql = `
      SELECT table_name 
      FROM information_schema.tables 
      WHERE table_schema = 'public' 
      ORDER BY table_name;
    `;
    const res = await runQuery(sql);
    if (res.success) {
      console.log('\n--- Public Tables ---');
      printTable(res.rows, ['table_name']);
    } else {
      console.log('Error:', res.error);
    }
    return true;
  }

  if (trimmed.startsWith('\\d ') || trimmed.startsWith('.schema ')) {
    const tableName = trimmed.split(/\s+/)[1].replace(/['";]/g, '');
    const sql = `
      SELECT column_name, data_type, is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = '${tableName}'
      ORDER BY ordinal_position;
    `;
    const res = await runQuery(sql);
    if (res.success && res.rows.length > 0) {
      console.log(`\n--- Schema for table: ${tableName} ---`);
      printTable(res.rows, ['column_name', 'data_type', 'is_nullable', 'column_default']);
    } else {
      console.log(`Table '${tableName}' not found or has no columns.\n`);
    }
    return true;
  }

  return false;
}

// Main execution
(async () => {
  const args = process.argv.slice(2);

  // If query passed via command line argument: e.g. node db_cli.js "SELECT * FROM bookings;"
  if (args.length > 0) {
    const rawInput = args.join(' ').trim();
    if (await handleMetaCommand(rawInput)) process.exit(0);

    const res = await runQuery(rawInput);
    if (res.success) {
      if (res.rows && res.rows.length > 0) {
        printTable(res.rows, res.fields);
      } else {
        console.log(`Query OK. ${res.command || 'Done'} (rowCount: ${res.rowCount || 0})\n`);
      }
      process.exit(0);
    } else {
      console.error(`❌ Error: ${res.error}\n`);
      process.exit(1);
    }
  }

  // Interactive REPL Mode
  const isCloud = process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost');
  console.log('========================================================================');
  if (isCloud) {
    console.log('☁️  RailGo Live Cloud Database Terminal (Antideploy Neon PostgreSQL)');
    console.log('   Host: ep-delicate-darkness-b3po0c7h-pooler.c-4.ap-southeast-1.aws.neon.tech');
    console.log('   All data entered on https://railgo.antideploy.app is queryable in REAL TIME.');
  } else {
    console.log('🚆 RailGo Local Database Terminal (PGlite Embedded)');
  }
  console.log('========================================================================');
  console.log('Type SQL queries ending with ";" or shortcuts:');
  console.log('  \\b or \\bookings       Show recent train bookings');
  console.log('  \\p or \\passengers     Show recent passengers with PIDs');
  console.log('  \\i or \\inventory      Show real-time seat inventory');
  console.log('  \\r or \\refunds        Show recent refunds');
  console.log('  \\dt or .tables        List all tables');
  console.log('  \\d <table_name>       Describe table structure');
  console.log('  help                  Show all shortcuts');
  console.log('  \\q or exit            Exit terminal shell');
  console.log('------------------------------------------------------------------------\n');

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: 'railgo_db=> '
  });

  let buffer = '';

  rl.prompt();

  rl.on('line', async line => {
    const trimmed = line.trim();

    if (!buffer && (trimmed.startsWith('\\') || trimmed.startsWith('.') || ['exit', 'quit', 'help'].includes(trimmed))) {
      await handleMetaCommand(trimmed);
      rl.prompt();
      return;
    }

    buffer += (buffer ? ' ' : '') + line;

    if (buffer.trim().endsWith(';')) {
      const sqlToExec = buffer.trim();
      buffer = '';
      const res = await runQuery(sqlToExec);
      if (res.success) {
        if (res.rows && res.rows.length > 0) {
          printTable(res.rows, res.fields);
        } else {
          console.log(`Query OK: ${res.command || 'SUCCESS'} (affected: ${res.rowCount || 0})\n`);
        }
      } else {
        console.error(`❌ SQL Error: ${res.error}\n`);
      }
      rl.setPrompt('railgo_db=> ');
      rl.prompt();
    } else if (buffer.trim()) {
      rl.setPrompt('railgo_db-> ');
      rl.prompt();
    } else {
      rl.prompt();
    }
  });

  rl.on('close', () => {
    console.log('\nBye!');
    process.exit(0);
  });
})();
