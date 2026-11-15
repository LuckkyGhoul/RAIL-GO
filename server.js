const path = require('path');
const fs = require('fs');

// Resolve dependencies from extra_files/node_modules if moved
const extraModules = path.join(__dirname, '..', 'extra_files', 'node_modules');
if (fs.existsSync(extraModules) && !module.paths.includes(extraModules)) {
  module.paths.unshift(extraModules);
}

try { require('dotenv').config(); } catch(e) {}

const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { query, exec, transaction, initDb, getDefaultTierSeats } = require('./db');

const app = express();
const PORT = process.env.PORT || 8090;
const JWT_SECRET = process.env.JWT_SECRET || 'irctc_super_secure_jwt_secret_key_2026';

// Middleware with secure CORS
const allowedOrigins = [
  'https://railgo.antideploy.app',
  'http://localhost:8090',
  'http://127.0.0.1:8090',
  'http://localhost:3000'
];
app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin) || origin.endsWith('.antideploy.app')) {
      callback(null, true);
    } else {
      callback(null, false);
    }
  },
  credentials: true
}));
app.use(express.json());

// Serve static frontend files from /public
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));

// Helper: JWT verification middleware
function authenticateToken(req, res, next) {
  const authHeader = req.headers['authorization'];
  const token = authHeader && authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'Authentication required' });

  jwt.verify(token, JWT_SECRET, (err, user) => {
    if (err) return res.status(403).json({ success: false, message: 'Invalid or expired token' });
    req.user = user;
    next();
  });
}

// ----------------------------------------------------
// Helper: Get or Create Live Seat Inventory for (train, date, class, quota)
// ----------------------------------------------------
async function getOrCreateInventory(trainNo, journeyDate, classCode, quota = 'GN') {
  const dateStr = typeof journeyDate === 'string' ? journeyDate.slice(0, 10) : journeyDate.toISOString().slice(0, 10);
  
  const res = await query(`
    SELECT * FROM seat_inventory
    WHERE train_no = $1 AND journey_date = $2 AND class_code = $3 AND quota = $4
  `, [trainNo, dateStr, classCode, quota]);

  if (res.rows.length > 0) {
    return res.rows[0];
  }

  // Seed default seats (< 12 seats, green tiers available, yellow tiers in WL)
  const def = typeof getDefaultTierSeats === 'function' ? getDefaultTierSeats(classCode) : { available: 4, wl: 0 };
  const insertRes = await query(`
    INSERT INTO seat_inventory (train_no, journey_date, class_code, quota, total_seats, available_seats, booked_seats, wl_count)
    VALUES ($1, $2, $3, $4, 50, $5, 0, $6)
    ON CONFLICT (train_no, journey_date, class_code, quota) DO NOTHING
    RETURNING *
  `, [trainNo, dateStr, classCode, quota, def.available, def.wl]);

  if (insertRes.rows.length > 0) {
    return insertRes.rows[0];
  }

  // In case of conflict, re-fetch
  const refetch = await query(`
    SELECT * FROM seat_inventory
    WHERE train_no = $1 AND journey_date = $2 AND class_code = $3 AND quota = $4
  `, [trainNo, dateStr, classCode, quota]);
  return refetch.rows[0];
}

// ----------------------------------------------------
// 1. Healthcheck & Database Status
// ----------------------------------------------------
app.get('/api/health', async (req, res) => {
  try {
    const dbRes = await query('SELECT version()');
    res.json({
      status: 'UP',
      timestamp: new Date().toISOString(),
      database: 'PostgreSQL',
      version: dbRes.rows[0]?.version || 'PostgreSQL'
    });
  } catch (err) {
    res.status(500).json({ status: 'DOWN', error: err.message });
  }
});

// ----------------------------------------------------
// 2. Authentication: Signup & Login
// ----------------------------------------------------
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { name, email, mobile, password } = req.body;
    if (!name || !email || !mobile || !password) {
      return res.status(400).json({ success: false, message: 'All fields are required' });
    }

    const trimmedEmail = email.trim().toLowerCase();
    const existing = await query('SELECT id FROM users WHERE email = $1', [trimmedEmail]);
    if (existing.rows.length > 0) {
      return res.status(400).json({ success: false, message: 'Email is already registered. Please login.' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const insertRes = await query(`
      INSERT INTO users (name, email, mobile, password_hash)
      VALUES ($1, $2, $3, $4)
      RETURNING id, name, email, mobile
    `, [name.trim(), trimmedEmail, mobile.trim(), passwordHash]);

    const newUser = insertRes.rows[0];
    res.json({
      success: true,
      message: 'Account created successfully! You can now login.',
      user: newUser
    });
  } catch (err) {
    console.error('Signup error:', err);
    res.status(500).json({ success: false, message: 'Server error during signup: ' + err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ success: false, message: 'Email and password are required' });
    }

    const trimmedEmail = email.trim().toLowerCase();
    const result = await query('SELECT * FROM users WHERE email = $1', [trimmedEmail]);
    if (result.rows.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid email or password' });
    }

    const user = result.rows[0];
    const isMatch = await bcrypt.compare(password, user.password_hash);
    if (!isMatch) {
      return res.status(400).json({ success: false, message: 'Invalid email or password' });
    }

    const token = jwt.sign(
      { id: user.id, name: user.name, email: user.email, mobile: user.mobile },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.json({
      success: true,
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        mobile: user.mobile
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    res.status(500).json({ success: false, message: 'Server error during login: ' + err.message });
  }
});

app.get('/api/auth/me', authenticateToken, (req, res) => {
  res.json({ success: true, user: req.user });
});

// ----------------------------------------------------
// 3. Stations API
// ----------------------------------------------------
app.get('/api/stations', async (req, res) => {
  try {
    const result = await query('SELECT code, name, city, state FROM stations ORDER BY code ASC');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// 4. Train Search API with Dynamic Seat Inventory
//    (Seat numbers decrease in real-time after bookings)
// ----------------------------------------------------
app.get('/api/trains', async (req, res) => {
  try {
    const { from, to, date, quota = 'GN' } = req.query;
    const journeyDate = date || new Date().toISOString().slice(0, 10);

    let sql = 'SELECT * FROM trains';
    let params = [];

    if (from && to) {
      // Find trains matching either direct source/dest or intermediate route halts
      sql = `
        SELECT DISTINCT t.* FROM trains t
        LEFT JOIN train_schedules s1 ON t.train_no = s1.train_no AND s1.station_code = $1
        LEFT JOIN train_schedules s2 ON t.train_no = s2.train_no AND s2.station_code = $2
        WHERE (t.source_code = $1 AND t.dest_code = $2)
           OR (s1.id IS NOT NULL AND s2.id IS NOT NULL AND s1.stop_number < s2.stop_number)
      `;
      params = [from, to];
    }

    let result = await query(sql, params);

    // Fallback: if no direct match, return all trains
    if (result.rows.length === 0) {
      result = await query('SELECT * FROM trains ORDER BY train_no ASC');
    }

    // Format trains with live dynamic seat inventory from PostgreSQL
    const trains = [];
    for (const t of result.rows) {
      const classList = typeof t.classes === 'string' ? t.classes.split(',') : t.classes;

      const availabilities = {};
      const seatCounts = {};
      const wlCounts = {};

      for (const cls of classList) {
        const inv = await getOrCreateInventory(t.train_no, journeyDate, cls, quota);
        if (inv.available_seats > 0) {
          availabilities[cls] = `AVAILABLE - ${inv.available_seats}`;
        } else {
          availabilities[cls] = `WL # ${inv.wl_count > 0 ? inv.wl_count : 1}`;
        }
        seatCounts[cls] = inv.available_seats;
        wlCounts[cls] = inv.wl_count > 0 ? inv.wl_count : 1;
      }

      trains.push({
        id: t.id,
        num: t.train_no,
        train_no: t.train_no,
        name: t.train_name,
        train_name: t.train_name,
        from: t.source_code,
        to: t.dest_code,
        from_station: t.source_code,
        to_station: t.dest_code,
        dep: t.departure_time,
        arr: t.arrival_time,
        departure: t.departure_time,
        arrival: t.arrival_time,
        dur: t.duration,
        duration: t.duration,
        runs: t.runs_on,
        sf: t.is_superfast,
        pantry: t.has_pantry,
        classes: classList,
        availability: availabilities,
        live_seat_counts: seatCounts,
        wl_counts: wlCounts
      });
    }

    res.json(trains);
  } catch (err) {
    console.error('Train search error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ----------------------------------------------------
// 5. ALL TRAINS LIST WITH DEFAULT STATION REACHING TIMES
//    (Includes Dehradun, Haridwar, Lucknow, Rishikesh, Roorkee)
// ----------------------------------------------------
app.get('/api/trains/all', async (req, res) => {
  try {
    const trainsRes = await query(`
      SELECT t.*, s1.name as source_name, s2.name as dest_name
      FROM trains t
      LEFT JOIN stations s1 ON t.source_code = s1.code
      LEFT JOIN stations s2 ON t.dest_code = s2.code
      ORDER BY t.train_no ASC
    `);

    const schedulesRes = await query(`
      SELECT ts.*, s.city, s.state
      FROM train_schedules ts
      LEFT JOIN stations s ON ts.station_code = s.code
      ORDER BY ts.train_no ASC, ts.stop_number ASC
    `);

    const schedulesByTrain = {};
    for (const sc of schedulesRes.rows) {
      if (!schedulesByTrain[sc.train_no]) schedulesByTrain[sc.train_no] = [];
      schedulesByTrain[sc.train_no].push({
        stop_number: sc.stop_number,
        station_code: sc.station_code,
        station_name: sc.station_name,
        city: sc.city,
        state: sc.state,
        arrival_time: sc.arrival_time,
        departure_time: sc.departure_time,
        halt_minutes: sc.halt_minutes,
        distance_km: sc.distance_km,
        day_count: sc.day_count,
        travel_time_from_start: sc.travel_time_from_start || (sc.distance_km > 0 ? `${Math.round(sc.distance_km / 60)}h` : '0m')
      });
    }

    const trainsWithSchedules = trainsRes.rows.map(t => ({
      id: t.id,
      train_no: t.train_no,
      train_name: t.train_name,
      source_code: t.source_code,
      source_name: t.source_name || t.source_code,
      dest_code: t.dest_code,
      dest_name: t.dest_name || t.dest_code,
      departure_time: t.departure_time,
      arrival_time: t.arrival_time,
      duration: t.duration,
      runs_on: t.runs_on,
      is_superfast: t.is_superfast,
      has_pantry: t.has_pantry,
      classes: typeof t.classes === 'string' ? t.classes.split(',') : t.classes,
      total_stops: schedulesByTrain[t.train_no]?.length || 2,
      schedule: schedulesByTrain[t.train_no] || [
        { stop_number: 1, station_code: t.source_code, station_name: t.source_name || t.source_code, arrival_time: 'START', departure_time: t.departure_time, halt_minutes: 0, distance_km: 0, day_count: 1, travel_time_from_start: '0m' },
        { stop_number: 2, station_code: t.dest_code, station_name: t.dest_name || t.dest_code, arrival_time: t.arrival_time, departure_time: 'ENDS', halt_minutes: 0, distance_km: 800, day_count: 1, travel_time_from_start: t.duration }
      ]
    }));

    res.json({
      success: true,
      total_trains: trainsWithSchedules.length,
      trains: trainsWithSchedules
    });
  } catch (err) {
    console.error('All trains fetch error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Single train schedule
app.get('/api/trains/:trainNo/schedule', async (req, res) => {
  try {
    const { trainNo } = req.params;
    const trainRes = await query('SELECT * FROM trains WHERE train_no = $1', [trainNo]);
    if (trainRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Train not found' });
    }

    const scheduleRes = await query(`
      SELECT ts.*, s.city, s.state
      FROM train_schedules ts
      LEFT JOIN stations s ON ts.station_code = s.code
      WHERE ts.train_no = $1
      ORDER BY ts.stop_number ASC
    `, [trainNo]);

    res.json({
      success: true,
      train: trainRes.rows[0],
      stops: scheduleRes.rows
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------
// ----------------------------------------------------
// OS FCFS THREAD SCHEDULER ENGINE INTEGRATION
// Launches booking_fcfs.exe in a visible Windows terminal
// ----------------------------------------------------
async function runFcfsBookingScheduler(bookingInfo) {
  if (process.platform !== 'win32') {
    return runFcfsFallback(bookingInfo);
  }

  const exePath = path.resolve(__dirname, '..', 'os_concepts', 'booking_fcfs.exe');
  if (!fs.existsSync(exePath)) {
    return runFcfsFallback(bookingInfo);
  }

  const tempId = Date.now() + '_' + Math.floor(Math.random() * 100000);
  const inPath = path.resolve(__dirname, '..', 'os_concepts', `booking_in_${tempId}.txt`);
  const outPath = path.resolve(__dirname, '..', 'os_concepts', `booking_out_${tempId}.json`);

  try {
    const lines = [
      `PNR: ${bookingInfo.pnr}`,
      `TRAIN_NO: ${bookingInfo.train_no}`,
      `TRAIN_NAME: ${bookingInfo.train_name || 'Express Special'}`,
      `DATE: ${bookingInfo.journey_date}`,
      `FROM: ${bookingInfo.from_station}`,
      `TO: ${bookingInfo.to_station}`,
      `CLASS: ${bookingInfo.class_code}`,
      `AVAILABLE_SEATS: ${bookingInfo.available_seats}`
    ];
    for (const p of bookingInfo.passengers) {
      const pName = (p.name || p.pax_name || 'Passenger').replace(/[\r\n|]/g, ' ');
      const pAge = parseInt(p.age) || 28;
      const pGender = (p.gender || 'M').replace(/[\r\n|]/g, '');
      const pBerth = (p.berth_pref || p.berth || 'NP').replace(/[\r\n|]/g, '');
      const pQuota = (p.quota || p.pax_quota || 'GENERAL').replace(/[\r\n|]/g, '');
      lines.push(`PASSENGER: ${pName}|${pAge}|${pGender}|${pBerth}|${pQuota}`);
    }

    fs.writeFileSync(inPath, lines.join('\n') + '\n', 'utf8');

    const cmd = `start "RailGo OS Engine - Priority Thread Scheduler" /wait cmd.exe /c ""${exePath}" "${inPath}" "${outPath}""`;
    const { spawn } = require('child_process');
    await new Promise((resolve) => {
      let resolved = false;
      const done = () => {
        if (!resolved) {
          resolved = true;
          resolve();
        }
      };

      try {
        const child = spawn(cmd, {
          shell: true,
          detached: true,
          stdio: 'ignore'
        });
        child.on('exit', () => done());
        child.on('error', (err) => {
          console.warn('Priority scheduler terminal notice:', err.message || err);
          done();
        });
      } catch (spawnErr) {
        console.warn('Priority scheduler spawn error:', spawnErr.message || spawnErr);
        done();
      }

      // Check for output file or timeout after 6.5s
      let elapsed = 0;
      const interval = setInterval(() => {
        elapsed += 200;
        if (fs.existsSync(outPath) && elapsed >= 2600) {
          clearInterval(interval);
          done();
        } else if (elapsed >= 6500) {
          clearInterval(interval);
          done();
        }
      }, 200);
    });

    if (fs.existsSync(outPath)) {
      const raw = fs.readFileSync(outPath, 'utf8');
      const data = JSON.parse(raw);
      return data;
    }
  } catch (err) {
    console.error('Error running booking_fcfs (Priority Scheduler):', err);
  } finally {
    try { if (fs.existsSync(inPath)) fs.unlinkSync(inPath); } catch (e) {}
    try { if (fs.existsSync(outPath)) fs.unlinkSync(outPath); } catch (e) {}
  }

  return runFcfsFallback(bookingInfo);
}

function runFcfsFallback(bookingInfo) {
  const hostPid = 30000 + Math.floor(Math.random() * 50000);
  const avail = Math.max(0, parseInt(bookingInfo.available_seats) || 0);
  const paxList = bookingInfo.passengers || [];
  const coaches = ['S1', 'S2', 'B1', 'C1'];
  const coach = coaches[Math.floor(Math.random() * coaches.length)];

  function getQuotaPriority(q) {
    if (!q) return 6;
    const s = String(q).toUpperCase();
    if (s.includes('EMERGENCY') || s.includes('EMG')) return 1;
    if (s.includes('RAILWAY') || s.includes('RLW')) return 2;
    if (s.includes('HANDICAP') || s.includes('DIVYAANG') || s.includes('HP') || s.includes('PH')) return 3;
    if (s.includes('STUDENT') || s.includes('STU')) return 4;
    if (s.includes('TATKAL') || s.includes('PREMIUM') || s.includes('PT') || s.includes('TQ')) return 5;
    return 6;
  }

  function getQuotaName(prio) {
    switch(prio) {
      case 1: return 'Emergency Quota';
      case 2: return 'Railway Quota';
      case 3: return 'Handicapped Quota';
      case 4: return 'Student Quota';
      case 5: return 'Tatkal Premium';
      default: return 'General Quota';
    }
  }

  const passengers = paxList.map((p, idx) => {
    const prio = getQuotaPriority(p.quota || p.pax_quota);
    return {
      index: idx + 1,
      name: p.name || p.pax_name || `Passenger ${idx + 1}`,
      age: parseInt(p.age) || 28,
      gender: p.gender || 'M',
      berth_pref: p.berth_pref || p.berth || 'NP',
      quota: getQuotaName(prio),
      priority: prio,
      pid: hostPid + idx,
      tid: 1000 + Math.floor(Math.random() * 60000),
      status: 'WL',
      coach: 'WL',
      berth_no: 'WL'
    };
  });

  // Priority scheduling: Sort by priority ASC, break ties with index ASC
  const sortedIndices = passengers.map((_, i) => i).sort((a, b) => {
    if (passengers[a].priority !== passengers[b].priority) {
      return passengers[a].priority - passengers[b].priority;
    }
    return passengers[a].index - passengers[b].index;
  });

  let remaining = avail;
  let confirmed = 0;
  let waitlist = 0;

  for (const idx of sortedIndices) {
    if (remaining > 0) {
      remaining--;
      confirmed++;
      passengers[idx].status = 'CNF';
      passengers[idx].coach = coach;
      passengers[idx].berth_no = String(12 + confirmed * 3);
    } else {
      waitlist++;
      passengers[idx].status = 'WL';
      passengers[idx].coach = 'WL';
      passengers[idx].berth_no = `WL #${waitlist}`;
    }
  }

  return {
    success: true,
    ticket_pid: passengers[0]?.pid || hostPid,
    pnr: bookingInfo.pnr,
    confirmed_count: confirmed,
    waitlisted_count: waitlist,
    overall_status: waitlist === 0 ? 'CNF' : (confirmed > 0 ? 'PARTIAL_CNF' : 'WL'),
    passengers
  };
}

// ----------------------------------------------------
// 6. BOOK TICKET API
//    Priority Scheduling Multi-Threaded Process & Terminal Dispatch
// ----------------------------------------------------
app.post('/api/book', async (req, res) => {
  try {
    const {
      train_id, train_no, journey_date, class_code, quota = 'GN',
      passengers, contact_mobile, contact_email, total_fare,
      payment_method, is_waitlist, requested_status
    } = req.body;

    if (!train_no || !journey_date || !class_code || !passengers || passengers.length === 0) {
      return res.status(400).json({ success: false, message: 'Invalid booking data' });
    }

    // Lookup train
    const trainRes = await query('SELECT * FROM trains WHERE train_no = $1', [train_no]);
    const train = trainRes.rows[0] || {
      train_no,
      train_name: req.body.train_name || 'Express Special',
      source_code: req.body.from_station || 'NDLS',
      dest_code: req.body.to_station || 'DDN',
      departure_time: req.body.departure || '06:45',
      arrival_time: req.body.arrival || '12:55',
      duration: req.body.duration || '6h 10m'
    };

    const numPax = passengers.length;

    // Generate unique 10-digit PNR
    let pnr = '';
    let isUnique = false;
    while (!isUnique) {
      pnr = Math.floor(1000000000 + Math.random() * 9000000000).toString();
      const check = await query('SELECT id FROM bookings WHERE pnr = $1', [pnr]);
      if (check.rows.length === 0) isUnique = true;
    }

    // Get logged in user if auth token present
    let userId = null;
    let userName = 'Guest Passenger';
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.split(' ')[1]) {
      try {
        const decoded = jwt.verify(authHeader.split(' ')[1], JWT_SECRET);
        userId = decoded.id;
        userName = decoded.name;
      } catch (e) {}
    }

    const s1 = await query('SELECT name FROM stations WHERE code = $1', [train.source_code]);
    const s2 = await query('SELECT name FROM stations WHERE code = $1', [train.dest_code]);
    const fromName = s1.rows[0]?.name || train.source_code;
    const toName = s2.rows[0]?.name || train.dest_code;

    // Fare breakdown
    const baseFare = Math.round(Number(total_fare) * 0.75);
    const fareBreakdown = JSON.stringify({
      base_fare: baseFare,
      tatkal: (quota === 'TQ' || quota === 'PT') ? 200 : 0,
      reservation: 40 * numPax,
      gst: Math.round(Number(total_fare) * 0.05),
      service_fee: 15 * numPax,
      total: Number(total_fare)
    });

    // Concurrency Race Condition Protection:
    // Atomic Transaction with Row-Level Locking (FOR UPDATE)
    // When multiple users finish payment at the same time:
    // 1. PostgreSQL queues incoming payments in strict FCFS order down to the millisecond.
    // 2. The first transaction to acquire the lock sees the remaining available seats and claims them (CNF).
    // 3. Transactions arriving even a fraction of a second later see available_seats = 0 and enter WAITING LIST (WL).
    const txResult = await transaction(async (tx) => {
      // Step A: Ensure inventory row exists atomically with ON CONFLICT DO NOTHING
      const def = getDefaultTierSeats(class_code);
      await tx.query(`
        INSERT INTO seat_inventory (train_no, journey_date, class_code, quota, total_seats, available_seats, booked_seats, wl_count)
        VALUES ($1, $2, $3, $4, 50, $5, 0, $6)
        ON CONFLICT (train_no, journey_date, class_code, quota) DO NOTHING
      `, [train.train_no, journey_date, class_code, quota || 'GN', def.available, def.wl]);

      // Lock the exact inventory row atomically
      let invRes = await tx.query(`
        SELECT id, train_no, journey_date, class_code, quota, total_seats, available_seats, booked_seats, wl_count 
        FROM seat_inventory 
        WHERE train_no = $1 AND journey_date = $2 AND class_code = $3 AND quota = $4 
        FOR UPDATE
      `, [train.train_no, journey_date, class_code, quota || 'GN']);

      const inv = invRes.rows[0];

      const availableSeatsAtLock = Math.max(0, parseInt(inv.available_seats) || 0);
      console.log(`[RACE CONDITION LOCK] PNR: ${pnr} | Train: ${train.train_no} | Available Seats: ${availableSeatsAtLock}`);

      // Step B: Run OS Engine Priority / FCFS multi-threaded scheduler
      const schedResult = await runFcfsBookingScheduler({
        pnr,
        train_no: train.train_no,
        train_name: train.train_name,
        journey_date,
        from_station: train.source_code,
        to_station: train.dest_code,
        class_code,
        available_seats: availableSeatsAtLock,
        passengers
      });

      const overallStatus = schedResult.overall_status || (schedResult.waitlisted_count === 0 ? 'CNF' : (schedResult.confirmed_count > 0 ? 'PARTIAL_CNF' : 'WL'));
      const ticketPid = schedResult.ticket_pid || (30000 + Math.floor(Math.random() * 50000));

      // Step C: Atomically decrement available seats / increment wl_count inside the locked row
      if (schedResult.confirmed_count > 0 || schedResult.waitlisted_count > 0) {
        await tx.query(`
          UPDATE seat_inventory
          SET available_seats = GREATEST(0, available_seats - $1),
              booked_seats = booked_seats + $1,
              wl_count = wl_count + $2
          WHERE id = $3
        `, [schedResult.confirmed_count, schedResult.waitlisted_count, inv.id]);
      }

      // Step D: Insert booking record
      const bookingRes = await tx.query(`
        INSERT INTO bookings (
          pnr, ticket_pid, user_id, user_name, train_no, train_name,
          from_station, to_station, from_name, to_name,
          departure, arrival, duration, journey_date,
          class_code, quota, contact_mobile, contact_email,
          payment_method, total_fare, fare_breakdown, status
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10,
          $11, $12, $13, $14,
          $15, $16, $17, $18,
          $19, $20, $21, $22
        ) RETURNING *
      `, [
        pnr, ticketPid, userId, userName, train.train_no, train.train_name,
        train.source_code, train.dest_code, fromName, toName,
        train.departure_time, train.arrival_time, train.duration, journey_date,
        class_code, quota || 'GN', contact_mobile || '9876543210', contact_email || '',
        payment_method || 'UPI', Number(total_fare), fareBreakdown, overallStatus
      ]);

      const booking = bookingRes.rows[0];

      // Step E: Insert passengers
      const insertedPassengers = [];
      for (let i = 0; i < schedResult.passengers.length; i++) {
        const sp = schedResult.passengers[i];
        const pRes = await tx.query(`
          INSERT INTO passengers (
            booking_id, pnr, pax_name, age, gender, berth_pref, coach, berth_no, status, pid, tid, quota, priority
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
          RETURNING *
        `, [
          booking.id, pnr, sp.name, sp.age, sp.gender, sp.berth_pref,
          sp.coach, sp.berth_no, sp.status, sp.pid, sp.tid,
          sp.quota || 'General Quota', sp.priority || 6
        ]);
        insertedPassengers.push(pRes.rows[0]);
      }

      return {
        booking,
        schedResult,
        insertedPassengers,
        ticketPid,
        overallStatus,
        availableSeatsAtLock
      };
    });

    const { booking, schedResult, insertedPassengers, ticketPid, overallStatus, availableSeatsAtLock } = txResult;

    res.json({
      success: true,
      ticket_id: ticketPid,
      ticket_pid: ticketPid,
      pnr,
      status: overallStatus,
      confirmed_count: schedResult.confirmed_count,
      waitlisted_count: schedResult.waitlisted_count,
      is_waitlisted: schedResult.waitlisted_count > 0,
      is_race_condition: schedResult.waitlisted_count > 0,
      available_seats_before: availableSeatsAtLock,
      requested_passengers: numPax,
      message: schedResult.waitlisted_count > 0
        ? `⚡ OS Priority Scheduling: ${schedResult.confirmed_count} Confirmed (High Priority Quotas), ${schedResult.waitlisted_count} in Waiting List. Ticket ID (PID): ${ticketPid}`
        : `Booking Confirmed! All ${numPax} passenger threads allocated seats under Priority Scheduling. Ticket ID (PID): ${ticketPid}`,
      total_fare: booking.total_fare,
      train_no: booking.train_no,
      train_name: booking.train_name,
      from_station: booking.from_station,
      to_station: booking.to_station,
      from_name: booking.from_name,
      to_name: booking.to_name,
      departure: booking.departure,
      arrival: booking.arrival,
      duration: booking.duration,
      journey_date: booking.journey_date,
      class_code: booking.class_code,
      quota: booking.quota,
      payment_method: booking.payment_method,
      passengers: insertedPassengers
    });
  } catch (err) {
    console.error('Booking error:', err);
    res.status(500).json({ success: false, message: 'Booking failed: ' + err.message });
  }
});

// ----------------------------------------------------
// 7. GET TICKET API
// ----------------------------------------------------
app.get('/api/ticket/:pnr', async (req, res) => {
  try {
    const { pnr } = req.params;
    const bRes = await query('SELECT * FROM bookings WHERE pnr = $1', [pnr]);
    if (bRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Ticket not found for PNR: ' + pnr });
    }

    const booking = bRes.rows[0];
    const pRes = await query('SELECT * FROM passengers WHERE pnr = $1 ORDER BY id ASC', [pnr]);
    const rRes = await query('SELECT * FROM refunds WHERE pnr = $1 ORDER BY id DESC LIMIT 1', [pnr]);

    let fareBreakdown = {};
    try {
      fareBreakdown = typeof booking.fare_breakdown === 'string'
        ? JSON.parse(booking.fare_breakdown)
        : booking.fare_breakdown || {};
    } catch (e) {}

    res.json({
      success: true,
      pnr: booking.pnr,
      ticket_id: booking.ticket_pid || booking.pnr,
      ticket_pid: booking.ticket_pid,
      status: booking.status,
      total_fare: Number(booking.total_fare),
      train_no: booking.train_no,
      train_name: booking.train_name,
      from_station: booking.from_station,
      to_station: booking.to_station,
      from_name: booking.from_name,
      to_name: booking.to_name,
      departure: booking.departure,
      arrival: booking.arrival,
      duration: booking.duration,
      journey_date: booking.journey_date,
      class_code: booking.class_code,
      quota: booking.quota,
      contact_mobile: booking.contact_mobile,
      payment_method: booking.payment_method,
      booked_at: booking.booked_at,
      passengers: pRes.rows,
      fare_breakdown: fareBreakdown,
      refund: rRes.rows[0] || null
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ----------------------------------------------------
// 8. PNR STATUS LOOKUP API
//    Shows Train Normal Path, Travel Times & Passenger Status
// ----------------------------------------------------
app.get('/api/pnr/:pnr', async (req, res) => {
  try {
    const { pnr } = req.params;
    const bRes = await query('SELECT * FROM bookings WHERE pnr = $1', [pnr]);
    if (bRes.rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: 'No record found for PNR: ' + pnr + '. Please verify the 10-digit number.'
      });
    }

    const booking = bRes.rows[0];
    const pRes = await query('SELECT * FROM passengers WHERE pnr = $1 ORDER BY id ASC', [pnr]);
    
    // Train normal path with reaching times and travel time from origin
    const scheduleRes = await query(`
      SELECT ts.*, s.city, s.state
      FROM train_schedules ts
      LEFT JOIN stations s ON ts.station_code = s.code
      WHERE ts.train_no = $1
      ORDER BY ts.stop_number ASC
    `, [booking.train_no]);

    const rRes = await query('SELECT * FROM refunds WHERE pnr = $1 ORDER BY id DESC LIMIT 1', [pnr]);

    res.json({
      success: true,
      pnr: booking.pnr,
      ticket_id: booking.ticket_pid || booking.pnr,
      ticket_pid: booking.ticket_pid,
      status: booking.status,
      train_no: booking.train_no,
      train_name: booking.train_name,
      from_station: booking.from_station,
      to_station: booking.to_station,
      from_name: booking.from_name,
      to_name: booking.to_name,
      departure: booking.departure,
      arrival: booking.arrival,
      duration: booking.duration,
      journey_date: booking.journey_date,
      class_code: booking.class_code,
      quota: booking.quota,
      total_fare: Number(booking.total_fare),
      passengers: pRes.rows,
      chart_status: booking.status === 'CNF' ? 'CHART PREPARED' : (booking.status === 'PARTIAL_CNF' ? 'PARTIAL ALLOCATION' : 'WAITLISTED'),
      reaching_times: scheduleRes.rows,
      refund: rRes.rows[0] || null
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// PNR Search / Typeahead endpoint
app.get('/api/pnr-search', async (req, res) => {
  try {
    const q = req.query.q || '';
    if (!q || q.length < 3) return res.json({ success: true, results: [] });

    const results = await query(`
      SELECT pnr, train_no, train_name, from_name, to_name, journey_date, status
      FROM bookings
      WHERE pnr LIKE $1
      ORDER BY id DESC LIMIT 5
    `, [`%${q}%`]);

    res.json({ success: true, results: results.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------
// 9. LIVE 30-SECOND WAITLIST & RACING CONDITION RESOLUTION
//    Resolves contention: Allocates available seats, initiates partial/full refund
//    and accurately decrements seat inventory
// ----------------------------------------------------
app.post('/api/wl-confirm', async (req, res) => {
  try {
    const { pnr, force_result } = req.body;
    if (!pnr) {
      return res.status(400).json({ success: false, message: 'PNR is required' });
    }

    const bRes = await query('SELECT * FROM bookings WHERE pnr = $1', [pnr]);
    if (bRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }

    const booking = bRes.rows[0];
    const pRes = await query('SELECT * FROM passengers WHERE pnr = $1 ORDER BY id ASC', [pnr]);
    const passengers = pRes.rows;
    const totalPax = passengers.length;

    // Check inventory
    const inv = await getOrCreateInventory(booking.train_no, booking.journey_date, booking.class_code, booking.quota);

    let seatsToConfirm = 0;
    if (force_result === 'confirm') {
      seatsToConfirm = totalPax;
    } else if (force_result === 'reject') {
      seatsToConfirm = 0;
    } else {
      // Natural racing condition allocation based on real available seats in database
      seatsToConfirm = Math.min(totalPax, Math.max(0, inv.available_seats));
      // If inventory had 0, but forced demo or random allocation
      if (seatsToConfirm === 0 && inv.available_seats <= 0) {
        seatsToConfirm = 0;
      } else if (inv.available_seats > 0 && totalPax > inv.available_seats) {
        // Partial allocation
        seatsToConfirm = inv.available_seats;
      }
    }

    const unallocatedCount = totalPax - seatsToConfirm;
    const coaches = ['B1', 'B2', 'B3', 'S2', 'S4', 'A1'];

    // 1. Update confirmed passengers
    for (let i = 0; i < seatsToConfirm; i++) {
      const p = passengers[i];
      const coach = coaches[Math.floor(Math.random() * coaches.length)];
      const berth = Math.floor(Math.random() * 64) + 1;
      await query(`
        UPDATE passengers
        SET status = 'CNF', coach = $1, berth_no = $2
        WHERE id = $3
      `, [coach, String(berth), p.id]);
    }

    // 2. Update unallocated passengers
    for (let i = seatsToConfirm; i < totalPax; i++) {
      const p = passengers[i];
      await query(`
        UPDATE passengers
        SET status = 'WL', coach = 'WL', berth_no = $1
        WHERE id = $2
      `, [`WL #${i + 1}`, p.id]);
    }

    // 3. Update Seat Inventory (decrements available seats by confirmed count, increments wl_count)
    await query(`
      UPDATE seat_inventory
      SET available_seats = GREATEST(0, available_seats - $1),
          booked_seats = booked_seats + $1,
          wl_count = wl_count + $2
      WHERE id = $3
    `, [seatsToConfirm, unallocatedCount, inv.id]);

    // 4. Handle Refund and Booking Status
    let finalBookingStatus = 'CNF';
    let refundRef = null;
    let refundAmount = 0;

    if (unallocatedCount > 0) {
      // Calculate proportional partial or full refund
      const farePerPax = Number(booking.total_fare) / totalPax;
      refundAmount = Math.round(farePerPax * unallocatedCount);
      refundRef = 'REF' + Math.floor(1000000000 + Math.random() * 9000000000).toString();

      finalBookingStatus = seatsToConfirm > 0 ? 'PARTIAL_CNF' : 'NOT CONFIRMED (WL)';

      await query(`
        INSERT INTO refunds (pnr, refund_ref, amount, reason, status, payment_method, pax_count)
        VALUES ($1, $2, $3, $4, 'INITIATED', $5, $6)
      `, [
        pnr,
        refundRef,
        refundAmount,
        `Racing condition resolution: ${unallocatedCount} of ${totalPax} passengers unallocated due to seat contention`,
        booking.payment_method || 'Original Payment Source',
        unallocatedCount
      ]);
    }

    await query(`UPDATE bookings SET status = $1 WHERE pnr = $2`, [finalBookingStatus, pnr]);

    // Fetch refreshed passengers
    const updatedPassengers = await query('SELECT * FROM passengers WHERE pnr = $1 ORDER BY id ASC', [pnr]);

    res.json({
      success: true,
      pnr,
      status: finalBookingStatus,
      confirmed: seatsToConfirm > 0,
      total_passengers: totalPax,
      confirmed_count: seatsToConfirm,
      refunded_count: unallocatedCount,
      refund_amount: refundAmount,
      refund_ref: refundRef,
      passengers: updatedPassengers.rows,
      message: unallocatedCount > 0
        ? (seatsToConfirm > 0
            ? `⚡ Racing condition resolved! ${seatsToConfirm} passengers CONFIRMED. ${unallocatedCount} passengers unallocated — 100% refund of ₹${refundAmount} initiated (Ref: ${refundRef}).`
            : `❌ Another passenger completed payment first under FCFS. Berth unavailable. Ticket NOT CONFIRMED (WAITING LIST). 100% refund of ₹${refundAmount} initiated (Ref: ${refundRef}) to original payment method.`)
        : `🎉 All ${seatsToConfirm} passengers have been successfully CONFIRMED! Berths allocated.`
    });
  } catch (err) {
    console.error('Waitlist confirmation error:', err);
    res.status(500).json({ success: false, message: err.message });
  }
});

// ----------------------------------------------------
// 10. CANCEL TICKET API (Restores seat inventory)
// ----------------------------------------------------
app.post('/api/ticket/cancel', async (req, res) => {
  try {
    const { pnr, reason } = req.body;
    const bRes = await query('SELECT * FROM bookings WHERE pnr = $1', [pnr]);
    if (bRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Ticket not found' });
    }

    const booking = bRes.rows[0];
    if (booking.status === 'CANCELLED') {
      return res.status(400).json({ success: false, message: 'Ticket is already cancelled.' });
    }

    const pRes = await query('SELECT * FROM passengers WHERE pnr = $1', [pnr]);
    const numPax = pRes.rows.length;

    await query(`UPDATE bookings SET status = 'CANCELLED' WHERE pnr = $1`, [pnr]);
    await query(`UPDATE passengers SET status = 'CANCELLED' WHERE pnr = $1`, [pnr]);

    // Restore seats to inventory if ticket had confirmed seats
    if (booking.status === 'CNF' || booking.status === 'PARTIAL_CNF') {
      const inv = await getOrCreateInventory(booking.train_no, booking.journey_date, booking.class_code, booking.quota);
      await query(`
        UPDATE seat_inventory
        SET available_seats = available_seats + $1,
            booked_seats = GREATEST(0, booked_seats - $1)
        WHERE id = $2
      `, [numPax, inv.id]);
    }

    const refundRef = 'REF' + Math.floor(1000000000 + Math.random() * 9000000000);
    const refundAmount = Number(booking.total_fare) > 60 ? Number(booking.total_fare) - 60 : Number(booking.total_fare);

    await query(`
      INSERT INTO refunds (pnr, refund_ref, amount, reason, status, payment_method, pax_count)
      VALUES ($1, $2, $3, $4, 'INITIATED', $5, $6)
    `, [pnr, refundRef, refundAmount, reason || 'User requested cancellation', booking.payment_method, numPax]);

    res.json({
      success: true,
      message: 'Ticket cancelled successfully. Seats restored to inventory and refund initiated.',
      refund_ref: refundRef,
      refund_amount: refundAmount
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ----------------------------------------------------
// 11. TERMINAL DATABASE CLI QUERY ENDPOINT
// ----------------------------------------------------
app.post('/api/admin/query', async (req, res) => {
  try {
    const { sql } = req.body;
    if (!sql || typeof sql !== 'string') {
      return res.status(400).json({ success: false, error: 'SQL query string required' });
    }
    const result = await query(sql);
    res.json({
      success: true,
      command: result.command || 'SELECT',
      rowCount: result.rowCount !== undefined ? result.rowCount : (result.rows ? result.rows.length : 0),
      rows: result.rows || [],
      fields: result.fields ? result.fields.map(f => f.name) : (result.rows && result.rows[0] ? Object.keys(result.rows[0]) : [])
    });
  } catch (err) {
    res.status(400).json({ success: false, error: err.message });
  }
});
// ----------------------------------------------------
// 12. OS THREAD RACE TRIGGER (Spawns heavy C thread race in terminal)
// ----------------------------------------------------
app.post('/api/race', async (req, res) => {
  try {
    const { train_no = 'ALL', threads = 100000, seats = 4 } = req.body;
    const numThreads = Math.min(Math.max(parseInt(threads) || 100000, 100), 200000);
    const numSeats = Math.min(Math.max(parseInt(seats) || 4, 1), 20);
    const safeTrain = String(train_no).replace(/[^A-Za-z0-9_-]/g, '') || 'ALL';

    const raceExe = path.join(__dirname, '..', 'os_concepts', 'thread_race.exe');
    const raceBat = path.join(__dirname, '..', 'os_concepts', 'race.bat');

    let launchCmd = '';
    if (fs.existsSync(raceExe)) {
      launchCmd = `start "RailGo OS Thread Race (${safeTrain})" cmd /k ""${raceExe}" ${numThreads} ${numSeats} ${safeTrain}"`;
    } else if (fs.existsSync(raceBat)) {
      launchCmd = `start "RailGo OS Thread Race (${safeTrain})" cmd /k ""${raceBat}" ${numThreads} ${numSeats} ${safeTrain}"`;
    } else {
      return res.status(404).json({
        success: false,
        message: 'thread_race.exe not found. Compile os_concepts/thread_race.c first.'
      });
    }

    const { spawn } = require('child_process');
    const child = spawn(launchCmd, {
      shell: true,
      detached: true,
      stdio: 'ignore'
    });
    child.unref();

    res.json({
      success: true,
      message: `OS Thread Race opened in terminal for Train ${safeTrain}: ${numThreads} threads vs ${numSeats} seats`,
      threads: numThreads,
      seats: numSeats,
      train_no: safeTrain
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ----------------------------------------------------
// 13. RAILGO HOTELS API (Delhi, Banaras, Goa, Kolkata, Pune)
//     Filters out full hotels for selected date range until cancelled/removed
// ----------------------------------------------------
function normalizeHotelDates(checkIn, checkOut) {
  const inDate = checkIn ? new Date(checkIn) : new Date();
  const inStr = inDate.toISOString().slice(0, 10);
  let outDate = checkOut ? new Date(checkOut) : new Date(inDate.getTime() + 86400000);
  if (outDate <= inDate) {
    outDate = new Date(inDate.getTime() + 86400000);
  }
  const outStr = outDate.toISOString().slice(0, 10);
  const nights = Math.max(1, Math.round((outDate - inDate) / 86400000));
  return { inStr, outStr, nights };
}

app.get('/api/hotels', async (req, res) => {
  try {
    const { city = 'Delhi', check_in, check_out, members = 1 } = req.query;
    const reqMembers = Math.max(1, parseInt(members) || 1);
    const { inStr, outStr, nights } = normalizeHotelDates(check_in, check_out);

    const result = await query(`
      SELECT h.*,
        (h.max_capacity - COALESCE((
          SELECT SUM(hb.members)
          FROM hotel_bookings hb
          WHERE hb.hotel_id = h.id
            AND hb.status = 'CONFIRMED'
            AND hb.check_in < $3::date
            AND hb.check_out > $2::date
        ), 0))::int AS remaining_capacity
      FROM hotels h
      WHERE LOWER(h.city) = LOWER($1)
      ORDER BY h.max_capacity ASC, h.id ASC
    `, [city.trim(), inStr, outStr]);

    // Show ONLY hotels that still have empty space and can accommodate the requested members
    const availableHotels = result.rows
      .filter(h => h.remaining_capacity > 0 && h.remaining_capacity >= reqMembers)
      .map(h => ({
        ...h,
        nights,
        estimated_total: h.price_per_night * nights
      }));

    res.json({
      success: true,
      city: city.trim(),
      check_in: inStr,
      check_out: outStr,
      nights,
      members: reqMembers,
      hotels: availableHotels
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/hotels/book', async (req, res) => {
  try {
    const { hotel_id, check_in, check_out, members = 1, guest_name, contact_mobile } = req.body;
    const reqMembers = Math.max(1, parseInt(members) || 1);
    if (!hotel_id || !guest_name) {
      return res.status(400).json({ success: false, message: 'Hotel and guest name are required' });
    }

    const { inStr, outStr, nights } = normalizeHotelDates(check_in, check_out);

    const hRes = await query(`
      SELECT h.*,
        (h.max_capacity - COALESCE((
          SELECT SUM(hb.members)
          FROM hotel_bookings hb
          WHERE hb.hotel_id = h.id
            AND hb.status = 'CONFIRMED'
            AND hb.check_in < $3::date
            AND hb.check_out > $2::date
        ), 0))::int AS remaining_capacity
      FROM hotels h
      WHERE h.id = $1
    `, [hotel_id, inStr, outStr]);

    if (hRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Hotel not found' });
    }

    const hotel = hRes.rows[0];
    if (hotel.remaining_capacity < reqMembers) {
      return res.status(400).json({
        success: false,
        message: `Not enough capacity in ${hotel.name}. Only ${Math.max(0, hotel.remaining_capacity)} vacant spaces left for these dates.`
      });
    }

    const bookingRef = 'HTL' + Math.floor(1000000 + Math.random() * 9000000).toString();
    const totalPrice = hotel.price_per_night * nights;

    const ins = await query(`
      INSERT INTO hotel_bookings (
        booking_ref, hotel_id, city, hotel_name, check_in, check_out,
        members, guest_name, contact_mobile, total_price, status
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'CONFIRMED')
      RETURNING *
    `, [
      bookingRef, hotel.id, hotel.city, hotel.name, inStr, outStr,
      reqMembers, guest_name.trim(), contact_mobile || '9876543210', totalPrice
    ]);

    const remainingAfter = hotel.remaining_capacity - reqMembers;

    res.json({
      success: true,
      booking: ins.rows[0],
      remaining_after: remainingAfter,
      message: remainingAfter <= 0
        ? `Booked ${hotel.name}! All ${hotel.max_capacity} spaces are now full for ${inStr} to ${outStr}, so this hotel is now hidden until cancelled.`
        : `Booked ${hotel.name} (${reqMembers} guests). Remaining capacity for these dates: ${remainingAfter}/${hotel.max_capacity}.`
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.get('/api/hotels/bookings', async (req, res) => {
  try {
    const result = await query(`
      SELECT hb.*, h.max_capacity
      FROM hotel_bookings hb
      LEFT JOIN hotels h ON hb.hotel_id = h.id
      ORDER BY hb.id DESC
    `);
    res.json({ success: true, bookings: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

app.post('/api/hotels/cancel', async (req, res) => {
  try {
    const { booking_ref, remove = false } = req.body;
    if (!booking_ref) {
      return res.status(400).json({ success: false, message: 'booking_ref is required' });
    }

    let result;
    if (remove) {
      result = await query(`DELETE FROM hotel_bookings WHERE booking_ref = $1 RETURNING *`, [booking_ref]);
    } else {
      result = await query(`
        UPDATE hotel_bookings SET status = 'CANCELLED'
        WHERE booking_ref = $1 AND status = 'CONFIRMED'
        RETURNING *
      `, [booking_ref]);
    }

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, message: 'Active booking not found for ref: ' + booking_ref });
    }

    const b = result.rows[0];
    res.json({
      success: true,
      booking: b,
      message: `${remove ? 'Removed' : 'Cancelled'} booking ${booking_ref} at ${b.hotel_name}. Vacant capacity restored for ${String(b.check_in).slice(0, 10)}!`
    });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ====================================================
// 14. YUUKO AI ASSISTANT CHATBOT API
//     Handles Trains, Hotel Bookings, TTC, Past Bookings & Cancellations
// ====================================================
function getOptionalUser(req) {
  try {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return null;
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

function fmtYuukoDate(d) {
  if (!d) return '';
  if (d instanceof Date && !isNaN(d)) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

app.post('/api/yuuko/chat', async (req, res) => {
  try {
    const rawMsg = (req.body && req.body.message ? String(req.body.message) : '').trim();
    if (!rawMsg) {
      return res.status(400).json({ success: false, error: 'Message is required' });
    }

    const msg = rawMsg.toLowerCase();
    const user = getOptionalUser(req);
    const actions = [];

    // 1. Check for specific PNR (10 digits), Hotel Ref (HTL...), Flight Ref (FLT...), or Bus Ref (BUS...)
    const pnrMatch = rawMsg.match(/\b(\d{10})\b/);
    const htlMatch = rawMsg.match(/\b(HTL\d{4,12})\b/i);
    const fltMatch = rawMsg.match(/\b(FLT\d{4,12})\b/i);
    const busMatch = rawMsg.match(/\b(BUS\d{4,12})\b/i);
    const isCancelIntent = /\b(cancel|cancellation|cancellations|cancelled|refund|refunds|remove)\b/i.test(msg);

    if (pnrMatch) {
      const pnr = pnrMatch[1];
      const bRes = await query('SELECT * FROM bookings WHERE pnr = $1', [pnr]);
      if (bRes.rows.length === 0) {
        return res.json({
          success: true,
          reply: `I checked our RailGo database, and no booking was found for PNR **${pnr}**. Please verify the 10-digit PNR number.`,
          actions: [{ label: '📋 Past Bookings', prompt: 'Show my past bookings' }]
        });
      }
      const b = bRes.rows[0];
      const pRes = await query('SELECT pax_name, age, gender, coach, berth_no, status FROM passengers WHERE pnr = $1 ORDER BY id ASC', [pnr]);
      const rRes = await query('SELECT refund_ref, amount, status, reason FROM refunds WHERE pnr = $1 ORDER BY id DESC LIMIT 1', [pnr]);
      const paxLines = pRes.rows.map((p, i) =>
        `  ${i + 1}. ${p.pax_name} (${p.age}/${p.gender}) — ${p.coach ? `${p.coach}/${p.berth_no}` : 'Pending Berth'} [${p.status}]`
      ).join('\n');

      const chartStatus = b.status === 'CNF' ? 'CHART PREPARED (Confirmed)' :
                          b.status === 'PARTIAL_CNF' ? 'PARTIAL ALLOCATION' :
                          b.status === 'CANCELLED' ? 'CANCELLED' : 'WAITLISTED';

      let reply = `🪪 **TTC & PNR Verification — ${pnr}**\n` +
        `• **Train:** ${b.train_no} ${b.train_name}\n` +
        `• **Route:** ${b.from_name || b.from_station} (${b.from_station}) → ${b.to_name || b.to_station} (${b.to_station})\n` +
        `• **Journey Date:** ${fmtYuukoDate(b.journey_date)} | ${b.departure} → ${b.arrival} | Class ${b.class_code} (${b.quota})\n` +
        `• **Chart / Status:** ${chartStatus} | **Fare:** ₹${Number(b.total_fare).toLocaleString('en-IN')}\n` +
        `• **Passengers:**\n${paxLines || '  No passenger rows found'}`;

      if (rRes.rows.length > 0) {
        const rf = rRes.rows[0];
        reply += `\n• **Refund:** ₹${Number(rf.amount).toLocaleString('en-IN')} (${rf.status}, Ref: ${rf.refund_ref})`;
      }

      if (b.status !== 'CANCELLED') {
        if (isCancelIntent) {
          reply += `\n\nClick below to confirm cancelling PNR **${pnr}** and initiate your refund:`;
        }
        actions.push({ label: `❌ Cancel PNR ${pnr}`, action: 'cancel_train', payload: { pnr } });
      }
      actions.push({ label: `📅 Train ${b.train_no} Schedule`, prompt: `schedule for train ${b.train_no}` });
      return res.json({ success: true, reply, actions });
    }

    if (htlMatch) {
      const ref = htlMatch[1].toUpperCase();
      const hbRes = await query(`
        SELECT hb.*, h.name AS hotel_name, h.city, h.max_capacity
        FROM hotel_bookings hb
        JOIN hotels h ON h.id = hb.hotel_id
        WHERE UPPER(hb.booking_ref) = $1
      `, [ref]);
      if (hbRes.rows.length === 0) {
        return res.json({
          success: true,
          reply: `I couldn't find any hotel booking with reference **${ref}**.`,
          actions: [{ label: '🏨 My Hotel Bookings', action: 'open_hotel_bookings' }]
        });
      }
      const hb = hbRes.rows[0];
      let reply = `🏨 **Hotel Booking — ${hb.booking_ref}**\n` +
        `• **Hotel:** ${hb.hotel_name} (${hb.city}, Max Cap: ${hb.max_capacity})\n` +
        `• **Stay:** ${fmtYuukoDate(hb.check_in)} → ${fmtYuukoDate(hb.check_out)}\n` +
        `• **Guest:** ${hb.guest_name} (${hb.contact_mobile}) · ${hb.members} Member(s)\n` +
        `• **Status:** ${hb.status} | **Total:** ₹${Number(hb.total_price).toLocaleString('en-IN')}`;
      if (hb.status === 'CONFIRMED') {
        actions.push({ label: `❌ Cancel ${hb.booking_ref}`, action: 'cancel_hotel', payload: { booking_ref: hb.booking_ref, remove: false } });
      }
      actions.push({ label: '📋 Open Hotel Bookings', action: 'open_hotel_bookings' });
      return res.json({ success: true, reply, actions });
    }

    if (fltMatch || busMatch) {
      const isFlt = !!fltMatch;
      const ref = (fltMatch ? fltMatch[1] : busMatch[1]).toUpperCase();
      const table = isFlt ? 'flight_bookings' : 'bus_bookings';
      const rRes = await query(`SELECT * FROM ${table} WHERE UPPER(booking_ref) = $1`, [ref]);
      if (rRes.rows.length === 0) {
        return res.json({
          success: true,
          reply: `I couldn't find any ${isFlt ? 'flight' : 'bus'} booking with reference **${ref}**.`,
          actions: [{ label: isFlt ? '✈️ My Flight Bookings' : '🚌 My Bus Bookings', action: isFlt ? 'open_flight_bookings' : 'open_bus_bookings' }]
        });
      }
      const row = rRes.rows[0];
      const reply = `${isFlt ? '✈️ **Flight' : '🚌 **Bus'} Booking — ${row.booking_ref}**\n` +
        `• **${isFlt ? 'Flight' : 'Bus'}:** ${isFlt ? `${row.flight_no} (${row.airline})` : `${row.bus_no} (${row.operator})`}\n` +
        `• **Route:** ${row.from_city} → ${row.to_city} on ${fmtYuukoDate(row.travel_date)}\n` +
        `• **Passenger:** ${row.passenger_name} (${row.contact_mobile}) · ${row.passengers} Seat(s)\n` +
        `• **Status:** ${row.status} | **Total:** ₹${Number(row.total_price).toLocaleString('en-IN')}`;
      if (row.status === 'CONFIRMED') {
        actions.push({
          label: `❌ Cancel ${row.booking_ref}`,
          action: isFlt ? 'cancel_flight' : 'cancel_bus',
          payload: { booking_ref: row.booking_ref, remove: false }
        });
      }
      actions.push({ label: isFlt ? '✈️ Manage Flight Bookings' : '🚌 Manage Bus Bookings', action: isFlt ? 'open_flight_bookings' : 'open_bus_bookings' });
      return res.json({ success: true, reply, actions });
    }

    // 2. Cancellations & Refunds Intent
    if (isCancelIntent) {
      const canTrainsRes = await query(`
        SELECT pnr, train_no, train_name, journey_date, total_fare
        FROM bookings WHERE status = 'CANCELLED' ORDER BY id DESC LIMIT 4
      `);
      const refundsRes = await query(`SELECT pnr, refund_ref, amount, status FROM refunds ORDER BY id DESC LIMIT 5`);
      const canHotelsRes = await query(`
        SELECT hb.booking_ref, h.name AS hotel_name, h.city, hb.check_in, hb.check_out
        FROM hotel_bookings hb JOIN hotels h ON h.id = hb.hotel_id
        WHERE hb.status = 'CANCELLED' ORDER BY hb.id DESC LIMIT 4
      `);
      const canFlightsRes = await query(`
        SELECT booking_ref, flight_no, airline, from_city, to_city, travel_date
        FROM flight_bookings WHERE status = 'CANCELLED' ORDER BY id DESC LIMIT 4
      `);
      const canBusesRes = await query(`
        SELECT booking_ref, bus_no, operator, from_city, to_city, travel_date
        FROM bus_bookings WHERE status = 'CANCELLED' ORDER BY id DESC LIMIT 4
      `);
      const activeTrainRes = await query(`SELECT pnr FROM bookings WHERE status != 'CANCELLED' ORDER BY id DESC LIMIT 2`);
      const activeHotelRes = await query(`SELECT booking_ref, city FROM hotel_bookings WHERE status = 'CONFIRMED' ORDER BY id DESC LIMIT 1`);
      const activeFlightRes = await query(`SELECT booking_ref, from_city, to_city FROM flight_bookings WHERE status = 'CONFIRMED' ORDER BY id DESC LIMIT 1`);
      const activeBusRes = await query(`SELECT booking_ref, from_city, to_city FROM bus_bookings WHERE status = 'CONFIRMED' ORDER BY id DESC LIMIT 1`);

      let reply = `❌ **Cancellations & Refunds Overview**\n` +
        `**Policy:**\n` +
        `• **Train Tickets:** Restores confirmed seats & initiates refund (\`Total Fare − ₹60\` if fare > ₹60).\n` +
        `• **Hotels, Flights & Buses:** Cancelling restores vacant capacity/seats immediately.\n\n`;

      if (canTrainsRes.rows.length > 0 || refundsRes.rows.length > 0) {
        reply += `**Cancelled Train Tickets / Refunds:**\n`;
        const rfMap = new Map(refundsRes.rows.map(r => [r.pnr, r]));
        canTrainsRes.rows.forEach(t => {
          const rf = rfMap.get(t.pnr);
          reply += `• PNR **${t.pnr}** (${t.train_no} ${t.train_name}, ${fmtYuukoDate(t.journey_date)})` +
            (rf ? ` — Refund ₹${Number(rf.amount).toLocaleString('en-IN')} [${rf.status}, ${rf.refund_ref}]` : ` — CANCELLED`) + `\n`;
        });
      }
      if (canHotelsRes.rows.length > 0) {
        reply += `\n**Cancelled Hotels:**\n` + canHotelsRes.rows.map(h => `• **${h.booking_ref}** — ${h.hotel_name} (${h.city})`).join('\n') + `\n`;
      }
      if (canFlightsRes.rows.length > 0) {
        reply += `\n**Cancelled Flights:**\n` + canFlightsRes.rows.map(f => `• **${f.booking_ref}** — ${f.flight_no} ${f.airline} (${f.from_city}→${f.to_city})`).join('\n') + `\n`;
      }
      if (canBusesRes.rows.length > 0) {
        reply += `\n**Cancelled Buses:**\n` + canBusesRes.rows.map(b => `• **${b.booking_ref}** — ${b.bus_no} ${b.operator} (${b.from_city}→${b.to_city})`).join('\n') + `\n`;
      }
      if (canTrainsRes.rows.length + canHotelsRes.rows.length + canFlightsRes.rows.length + canBusesRes.rows.length === 0) {
        reply += `• No cancellations recorded yet across trains, hotels, flights, or buses.\n`;
      }

      if (activeTrainRes.rows.length + activeHotelRes.rows.length + activeFlightRes.rows.length + activeBusRes.rows.length > 0) {
        reply += `\nWant to cancel an active booking right now? Pick one below or type \`cancel <PNR/HTL/FLT/BUS Ref>\`:`;
        activeTrainRes.rows.forEach(t => actions.push({ label: `❌ Cancel PNR ${t.pnr}`, action: 'cancel_train', payload: { pnr: t.pnr } }));
        activeHotelRes.rows.forEach(h => actions.push({ label: `❌ Cancel ${h.booking_ref}`, action: 'cancel_hotel', payload: { booking_ref: h.booking_ref, remove: false } }));
        activeFlightRes.rows.forEach(f => actions.push({ label: `❌ Cancel ${f.booking_ref}`, action: 'cancel_flight', payload: { booking_ref: f.booking_ref, remove: false } }));
        activeBusRes.rows.forEach(b => actions.push({ label: `❌ Cancel ${b.booking_ref}`, action: 'cancel_bus', payload: { booking_ref: b.booking_ref, remove: false } }));
      }
      actions.push({ label: '📋 Hotel Bookings', action: 'open_hotel_bookings' });
      actions.push({ label: '✈️ Flight Bookings', action: 'open_flight_bookings' });
      actions.push({ label: '🚌 Bus Bookings', action: 'open_bus_bookings' });
      return res.json({ success: true, reply, actions });
    }

    // 3. Past Bookings Intent
    if (/\b(past|my|all|history|recent)\s*(booking|bookings|ticket|tickets|trip|trips|stay|stays|reservation|reservations|flight|flights|bus|buses)\b|\bmy\s+booking/i.test(msg) &&
        !/\b(tell me about|show all|available|search)\b/i.test(msg)) {
      let trainRows = [];
      let scopeLabel = 'Recent RailGo Bookings';
      if (user && user.id) {
        const uRes = await query(`SELECT * FROM bookings WHERE user_id = $1 ORDER BY id DESC LIMIT 5`, [user.id]);
        if (uRes.rows.length > 0) {
          trainRows = uRes.rows;
          scopeLabel = `Bookings for ${user.name}`;
        }
      }
      if (trainRows.length === 0) {
        trainRows = (await query(`SELECT * FROM bookings ORDER BY id DESC LIMIT 5`)).rows;
      }

      const hotelRows = (await query(`
        SELECT hb.*, h.name AS hotel_name, h.city FROM hotel_bookings hb
        JOIN hotels h ON h.id = hb.hotel_id ORDER BY hb.id DESC LIMIT 4
      `)).rows;
      const flightRows = (await query(`SELECT * FROM flight_bookings ORDER BY id DESC LIMIT 4`)).rows;
      const busRows = (await query(`SELECT * FROM bus_bookings ORDER BY id DESC LIMIT 4`)).rows;

      let reply = `📋 **${scopeLabel}**\n\n**🚆 Trains (${trainRows.length}):**\n` +
        (trainRows.length === 0 ? `• No train bookings yet.\n` :
          trainRows.map(b => `• **PNR ${b.pnr}** [${b.status}] — ${b.train_no} (${b.from_station}→${b.to_station}, ${fmtYuukoDate(b.journey_date)}, ₹${Number(b.total_fare).toLocaleString('en-IN')})`).join('\n') + '\n');

      reply += `\n**✈️ Flights (${flightRows.length}):**\n` +
        (flightRows.length === 0 ? `• No flight bookings yet.\n` :
          flightRows.map(f => `• **${f.booking_ref}** [${f.status}] — ${f.flight_no} ${f.airline} (${f.from_city}→${f.to_city}, ${fmtYuukoDate(f.travel_date)}, ${f.passengers} pax, ₹${Number(f.total_price).toLocaleString('en-IN')})`).join('\n') + '\n');

      reply += `\n**🚌 Buses (${busRows.length}):**\n` +
        (busRows.length === 0 ? `• No bus bookings yet.\n` :
          busRows.map(b => `• **${b.booking_ref}** [${b.status}] — ${b.bus_no} (${b.from_city}→${b.to_city}, ${fmtYuukoDate(b.travel_date)}, ${b.passengers} seat, ₹${Number(b.total_price).toLocaleString('en-IN')})`).join('\n') + '\n');

      reply += `\n**🏨 Hotels (${hotelRows.length}):**\n` +
        (hotelRows.length === 0 ? `• No hotel bookings yet.\n` :
          hotelRows.map(h => `• **${h.booking_ref}** [${h.status}] — ${h.hotel_name} (${h.city}, ${fmtYuukoDate(h.check_in)}→${fmtYuukoDate(h.check_out)}, ₹${Number(h.total_price).toLocaleString('en-IN')})`).join('\n') + '\n');

      if (trainRows.length > 0) actions.push({ label: `🔍 Check PNR ${trainRows[0].pnr}`, prompt: `check PNR ${trainRows[0].pnr}` });
      actions.push({ label: '✈️ Flight Bookings', action: 'open_flight_bookings' });
      actions.push({ label: '🚌 Bus Bookings', action: 'open_bus_bookings' });
      actions.push({ label: '🏨 Hotel Bookings', action: 'open_hotel_bookings' });
      return res.json({ success: true, reply, actions });
    }

    // 4. TTC (Travelling Ticket Checker / Train Time & Chart / Ticket & Tatkal Charges)
    if (/\b(ttc|tte|ticket checker|travelling ticket|ticket exam|chart|charting|rac|tatkal)\b/i.test(msg)) {
      const statsRes = await query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'CNF') AS cnf_cnt,
          COUNT(*) FILTER (WHERE status LIKE '%WL%') AS wl_cnt,
          COUNT(*) FILTER (WHERE status = 'CANCELLED') AS can_cnt
        FROM bookings
      `);
      const st = statsRes.rows[0] || { cnf_cnt: 0, wl_cnt: 0, can_cnt: 0 };

      const reply = `🪪 **TTC Guide (Ticket Checker, Charting & Rules)**\n\n` +
        `1. **TTC / TTE Onboard Verification:**\n` +
        `   • Carry a valid original photo ID (Aadhaar/PAN/Passport/DL) + e-ticket/PNR.\n` +
        `   • **CNF:** Confirmed seat/berth allotted. **RAC:** Shared side-lower berth (allowed to board; TTC upgrades if seats free up). **WL e-ticket:** Auto-cancelled after charting — cannot board reserved coaches.\n` +
        `2. **Train Time & Charting (TTC):**\n` +
        `   • Final reservation chart is prepared ~4 hours before train departure.\n` +
        `   • Live DB stats: **${st.cnf_cnt}** Confirmed, **${st.wl_cnt}** Waitlisted, **${st.can_cnt}** Cancelled bookings.\n` +
        `3. **Tatkal & Quota Timings:**\n` +
        `   • **General (GN):** Opens 120 days before at 08:00 AM.\n` +
        `   • **Tatkal (TQ):** Opens 1 day prior — AC at 10:00 AM, Non-AC at 11:00 AM.\n` +
        `   • **Premium Tatkal (PT):** Dynamic fare, 0% refund on cancellation.\n\n` +
        `💡 *Send me any 10-digit PNR number (e.g. from Past Bookings) and I'll verify its live TTC chart & coach/berth status!*`;

      actions.push({ label: '📋 Check Past Bookings', prompt: 'Show my past bookings' });
      actions.push({ label: '🚆 Check Train 12951', prompt: 'Schedule for train 12951' });
      return res.json({ success: true, reply, actions });
    }

    // 5. Hotels & Hotel Bookings Intent
    const cityAliases = [
      { key: 'Delhi', rx: /\b(delhi|new delhi|ndls)\b/i },
      { key: 'Banaras', rx: /\b(banaras|varanasi|kashi|bsb)\b/i },
      { key: 'Goa', rx: /\b(goa|madgaon|calangute|baga)\b/i },
      { key: 'Kolkata', rx: /\b(kolkata|calcutta|howrah)\b/i },
      { key: 'Pune', rx: /\b(pune|shivajinagar|deccan)\b/i }
    ];
    const matchedCityObj = cityAliases.find(c => c.rx.test(msg));
    const isHotelIntent = /\b(hotel|hotels|stay|stays|room|rooms|accommodat|hostel|lodge)\b/i.test(msg);

    if (isHotelIntent || (matchedCityObj && !/\b(train|trains|schedule|station|to|from)\b/i.test(msg))) {
      const targetCity = matchedCityObj ? matchedCityObj.key : null;
      const memMatch = rawMsg.match(/\b(\d{1,2})\s*(member|members|people|person|persons|guest|guests|pax)\b/i);
      const reqMembers = memMatch ? Math.max(1, parseInt(memMatch[1], 10)) : 1;

      const todayStr = new Date().toISOString().slice(0, 10);
      const tomorrowStr = new Date(Date.now() + 86400000).toISOString().slice(0, 10);

      if (targetCity) {
        const hRes = await query(`
          SELECT h.id, h.name, h.city, h.address, h.rating, h.price_per_night, h.max_capacity,
                 COALESCE(SUM(hb.members), 0)::int AS booked_members
          FROM hotels h
          LEFT JOIN hotel_bookings hb
            ON hb.hotel_id = h.id
           AND hb.status = 'CONFIRMED'
           AND hb.check_in < $3::date
           AND hb.check_out > $2::date
          WHERE LOWER(h.city) = LOWER($1)
          GROUP BY h.id
          ORDER BY h.max_capacity ASC
        `, [targetCity, todayStr, tomorrowStr]);

        const available = hRes.rows.filter(h => (h.max_capacity - h.booked_members) >= reqMembers && (h.max_capacity - h.booked_members) > 0);
        const hiddenCount = hRes.rows.length - available.length;

        let reply = `🏨 **Hotels in ${targetCity}** (for ${todayStr} → ${tomorrowStr}, ${reqMembers}+ member(s)):\n`;
        if (available.length === 0) {
          reply += `• No vacant hotels currently fit ${reqMembers} member(s) for tonight.\n`;
        } else {
          available.forEach(h => {
            const rem = h.max_capacity - h.booked_members;
            reply += `• **${h.name}** — Vacant: **${rem}/${h.max_capacity}** members | ₹${Number(h.price_per_night).toLocaleString('en-IN')}/night | ★${Number(h.rating).toFixed(1)}\n`;
          });
        }
        if (hiddenCount > 0) {
          reply += `\n*(${hiddenCount} hotel(s) hidden because capacity is full or smaller than ${reqMembers} members)*`;
        }
        actions.push({ label: `🏨 Search ${targetCity} Hotels`, action: 'open_hotels_city', payload: { city: targetCity } });
        actions.push({ label: '📋 My Hotel Bookings', action: 'open_hotel_bookings' });
        return res.json({ success: true, reply, actions });
      }

      const hbSummary = await query(`
        SELECT hb.booking_ref, h.name AS hotel_name, h.city, hb.check_in, hb.check_out, hb.members, hb.status
        FROM hotel_bookings hb JOIN hotels h ON h.id = hb.hotel_id
        ORDER BY hb.id DESC LIMIT 4
      `);
      let reply = `🏨 **RailGo Hotels & Stays**\n` +
        `We offer **20 hotels** across 5 exclusive cities: **Delhi, Banaras, Goa, Kolkata, Pune**.\n` +
        `• Each city has **4 hotels** with capacities for **3, 4, 6, and 10 members**.\n` +
        `• Once a hotel's vacant spots reach **0** for selected dates, it automatically disappears from search results until that booking is cancelled or removed.\n\n`;

      if (hbSummary.rows.length > 0) {
        reply += `**Recent Hotel Bookings:**\n`;
        hbSummary.rows.forEach(b => {
          reply += `• **${b.booking_ref}** [${b.status}] — ${b.hotel_name} (${b.city}), ${fmtYuukoDate(b.check_in)}→${fmtYuukoDate(b.check_out)}, ${b.members} guest(s)\n`;
        });
      } else {
        reply += `• No hotel bookings placed yet. Pick a city below to check availability!`;
      }

      actions.push({ label: '🏨 Open Hotels Search', action: 'open_hotels' });
      actions.push({ label: 'Delhi Hotels', prompt: 'Hotels in Delhi' });
      actions.push({ label: 'Goa Hotels', prompt: 'Hotels in Goa' });
      actions.push({ label: '📋 My Hotel Bookings', action: 'open_hotel_bookings' });
      return res.json({ success: true, reply, actions });
    }

    const filterTransportForChat = (rows, noCol, carrierCol, codeMatch) => {
      if (codeMatch) {
        return rows.filter(r => r[noCol].toLowerCase() === codeMatch[1].toLowerCase());
      }
      const matchSide = (city, code) =>
        msg.includes(city.toLowerCase()) || new RegExp(`\\b${code.toLowerCase()}\\b`, 'i').test(msg);
      const bothCities = rows.filter(r => matchSide(r.from_city, r.from_code) && matchSide(r.to_city, r.to_code));
      if (bothCities.length > 0) return bothCities;
      const singleSide = rows.filter(r =>
        matchSide(r.from_city, r.from_code) ||
        matchSide(r.to_city, r.to_code) ||
        msg.includes(r[carrierCol].toLowerCase().split(' ')[0])
      );
      return singleSide.length > 0 ? singleSide : rows;
    };

    // 5b. Flights Intent
    const flightNoMatch = rawMsg.match(/\b([A-Z0-9]{2}-\d{3,4})\b/i);
    if (flightNoMatch || /\b(flight|flights|airline|indigo|air india|spicejet|akasa|vistara|airfare|airport)\b/i.test(msg)) {
      const allFlights = (await query(`SELECT * FROM flights ORDER BY id ASC`)).rows;
      const matched = filterTransportForChat(allFlights, 'flight_no', 'airline', flightNoMatch);
      const shown = matched.slice(0, 7);
      let reply = `✈️ **RailGo Flights (${matched.length} matching routes):**\n` +
        shown.map(f =>
          `• **${f.flight_no} (${f.airline})** — ${f.from_city} (${f.from_code}) → ${f.to_city} (${f.to_code}) | ${f.departure_time}→${f.arrival_time} (${f.duration}) | ₹${Number(f.price_economy).toLocaleString('en-IN')}`
        ).join('\n');
      if (matched.length > shown.length) reply += `\n*...and ${matched.length - shown.length} more flights available.*`;

      actions.push({ label: '✈️ Search & Book Flights', action: 'open_flights' });
      actions.push({ label: '📋 My Flight Bookings', action: 'open_flight_bookings' });
      return res.json({ success: true, reply, actions });
    }

    // 5c. Buses Intent
    const busNoMatch = rawMsg.match(/\b([A-Z0-9]{2,4}-[A-Z]{2,3}-\d{3})\b/i);
    if (busNoMatch || /\b(bus|buses|volvo|upsrtc|utc|zingbus|intrcity|shivneri|sleeper bus|janrath|kadamba)\b/i.test(msg)) {
      const allBuses = (await query(`SELECT * FROM buses ORDER BY id ASC`)).rows;
      const matched = filterTransportForChat(allBuses, 'bus_no', 'operator', busNoMatch);
      const shown = matched.slice(0, 7);
      let reply = `🚌 **RailGo Intercity Buses (${matched.length} matching services):**\n` +
        shown.map(b =>
          `• **${b.bus_no} (${b.operator})** — ${b.from_city}→${b.to_city} | ${b.departure_time}→${b.arrival_time} (${b.duration}) | ${b.bus_type} | ₹${Number(b.fare).toLocaleString('en-IN')}`
        ).join('\n');
      if (matched.length > shown.length) reply += `\n*...and ${matched.length - shown.length} more buses available.*`;

      actions.push({ label: '🚌 Search & Book Buses', action: 'open_buses' });
      actions.push({ label: '📋 My Bus Bookings', action: 'open_bus_bookings' });
      return res.json({ success: true, reply, actions });
    }

    // 6. Trains & Schedules Intent
    const trainNoMatch = rawMsg.match(/\b([012]\d{4})\b/);
    const isTrainIntent = !!trainNoMatch || /\b(train|trains|schedule|route|station|express|rajdhani|shatabdi|duronto|superfast|vande)\b/i.test(msg);

    if (isTrainIntent) {
      if (trainNoMatch) {
        const tNo = trainNoMatch[1];
        const tRes = await query(`
          SELECT t.*, s1.name AS src_name, s2.name AS dst_name
          FROM trains t
          LEFT JOIN stations s1 ON s1.code = t.source_code
          LEFT JOIN stations s2 ON s2.code = t.dest_code
          WHERE t.train_no = $1
        `, [tNo]);

        if (tRes.rows.length === 0) {
          return res.json({
            success: true,
            reply: `I couldn't find train number **${tNo}** in RailGo's database. Try e.g. **12951** (Mumbai Rajdhani), **12055** (DDN Jan Shatabdi), or **12002** (Bhopal Shatabdi).`,
            actions: [{ label: '🚆 List Popular Trains', prompt: 'Show all trains' }]
          });
        }
        const t = tRes.rows[0];
        const schRes = await query(`
          SELECT station_code, station_name, arrival_time, departure_time, distance_km, day_count
          FROM train_schedules WHERE train_no = $1 ORDER BY stop_number ASC
        `, [tNo]);
        const stopsText = schRes.rows.map(s =>
          `  • ${s.station_code} (${s.station_name}) — Arr: ${s.arrival_time}, Dep: ${s.departure_time} (${s.distance_km} km, Day ${s.day_count})`
        ).join('\n');

        const reply = `🚆 **${t.train_no} — ${t.train_name}**\n` +
          `• **Route:** ${t.src_name || t.source_code} (${t.source_code}) → ${t.dst_name || t.dest_code} (${t.dest_code})\n` +
          `• **Timing:** ${t.departure_time} → ${t.arrival_time} (**${t.duration}**) | Runs: ${t.runs_on}\n` +
          `• **Classes:** ${t.classes} | Pantry: ${t.has_pantry ? 'Yes' : 'No'}\n\n` +
          `**Route Stops (${schRes.rows.length}):**\n${stopsText || '  Direct route stops not listed.'}`;
        return res.json({
          success: true,
          reply,
          actions: [{ label: '🔍 Check Another Train', prompt: 'Show popular trains' }]
        });
      }

      // Check station codes or city keywords in query
      const stRes = await query('SELECT code, name, city FROM stations');
      const matchedStations = stRes.rows.filter(s => {
        const cLow = s.code.toLowerCase();
        const cityLow = (s.city || '').toLowerCase();
        const nameLow = s.name.toLowerCase();
        return new RegExp(`\\b${cLow}\\b`, 'i').test(msg) ||
               (cityLow.length >= 3 && msg.includes(cityLow)) ||
               (nameLow.length >= 4 && msg.includes(nameLow));
      });

      let trainsList = [];
      if (matchedStations.length >= 2) {
        const codes = matchedStations.map(s => s.code);
        const rTrains = await query(`
          SELECT DISTINCT t.train_no, t.train_name, t.source_code, t.dest_code, t.departure_time, t.arrival_time, t.duration, t.classes
          FROM trains t
          WHERE t.source_code = ANY($1) AND t.dest_code = ANY($1)
          LIMIT 8
        `, [codes]);
        trainsList = rTrains.rows;
      } else if (matchedStations.length === 1) {
        const code = matchedStations[0].code;
        const rTrains = await query(`
          SELECT DISTINCT t.train_no, t.train_name, t.source_code, t.dest_code, t.departure_time, t.arrival_time, t.duration, t.classes
          FROM trains t
          LEFT JOIN train_schedules ts ON ts.train_no = t.train_no
          WHERE t.source_code = $1 OR t.dest_code = $1 OR ts.station_code = $1
          LIMIT 8
        `, [code]);
        trainsList = rTrains.rows;
      } else {
        // Check train name keyword like rajdhani, shatabdi, duronto, dehradun
        const words = msg.split(/\s+/).filter(w => w.length >= 4 && !['train', 'trains', 'about', 'show', 'tell', 'schedule', 'list', 'please', 'find', 'from'].includes(w));
        if (words.length > 0) {
          const rKw = await query(`
            SELECT train_no, train_name, source_code, dest_code, departure_time, arrival_time, duration, classes
            FROM trains WHERE LOWER(train_name) LIKE $1 LIMIT 8
          `, [`%${words[0]}%`]);
          trainsList = rKw.rows;
        }
      }

      if (trainsList.length === 0) {
        const cntRes = await query('SELECT COUNT(*)::int AS total FROM trains');
        const sampleRes = await query('SELECT train_no, train_name, source_code, dest_code, departure_time, arrival_time, duration, classes FROM trains ORDER BY id ASC LIMIT 6');
        trainsList = sampleRes.rows;
        let reply = `🚆 **RailGo Trains (${cntRes.rows[0].total} trains in network)**\nHere are some featured trains:\n`;
        trainsList.forEach(t => {
          reply += `• **${t.train_no} ${t.train_name}** (${t.source_code}→${t.dest_code}) | ${t.departure_time}→${t.arrival_time} (${t.duration}) | ${t.classes}\n`;
        });
        reply += `\n💡 *Ask me for a specific train number (e.g. \`12951\`), name (e.g. \`Rajdhani\`), or station (e.g. \`trains from Dehradun\`)!*`;
        return res.json({
          success: true,
          reply,
          actions: [
            { label: '📅 Train 12951 Schedule', prompt: 'Schedule for train 12951' },
            { label: '📅 Train 12055 Schedule', prompt: 'Schedule for train 12055' }
          ]
        });
      }

      let reply = `🚆 **Matching Trains (${trainsList.length} found):**\n`;
      trainsList.forEach(t => {
        reply += `• **${t.train_no} ${t.train_name}** (${t.source_code}→${t.dest_code}) | ${t.departure_time}→${t.arrival_time} (${t.duration}) | Classes: ${t.classes}\n`;
      });
      actions.push({ label: `📅 Schedule for ${trainsList[0].train_no}`, prompt: `Schedule for train ${trainsList[0].train_no}` });
      return res.json({ success: true, reply, actions });
    }

    // 7. Greeting / General Help
    const reply = `Hi${user ? ` **${user.name}**` : ''}! I'm **Yuuko** ✨, your RailGo Assistant.\n\n` +
      `I can help you live with:\n` +
      `• 🚆 **Trains & Schedules:** Ask about any train number (e.g. \`12951\`), route, or city.\n` +
      `• ✈️ **Flights:** Search flights across Delhi, Dehradun, Lucknow, Mumbai, Kolkata, Goa, Pune & more.\n` +
      `• 🚌 **Buses:** Check Volvo/AC buses across Uttarakhand, UP, Maharashtra, Goa & Bengaluru corridors.\n` +
      `• 🏨 **Hotel Bookings:** Check vacant hotels in **Delhi, Banaras, Goa, Kolkata, Pune** (capacities 3, 4, 6, 10).\n` +
      `• 🪪 **TTC & Chart Rules:** Check TTE verification, Tatkal timings, or enter any **10-digit PNR**.\n` +
      `• 📋 **Past Bookings & ❌ Cancellations:** View history or cancel PNRs, hotels, flights, or buses directly.`;

    return res.json({
      success: true,
      reply,
      actions: [
        { label: '🚆 Trains', prompt: 'Tell me about trains' },
        { label: '✈️ Flights', prompt: 'Tell me about flights' },
        { label: '🚌 Buses', prompt: 'Tell me about buses' },
        { label: '🏨 Hotels', prompt: 'Tell me about hotels' },
        { label: '🪪 TTC Rules', prompt: 'Explain TTC rules' },
        { label: '📋 Past Bookings', prompt: 'Show my past bookings' },
        { label: '❌ Cancellations', prompt: 'Show my cancellations and refunds' }
      ]
    });
  } catch (err) {
    console.error('Yuuko chat error:', err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ====================================================
// 15. FLIGHTS & INTERCITY BUSES APIs (Shared Corridor Data)
// ====================================================
const TRANSPORT_CITY_ALIASES = {
  ndls: 'delhi', nzm: 'delhi', dli: 'delhi', dee: 'delhi', anvt: 'delhi', del: 'delhi',
  ddn: 'dehradun', ded: 'dehradun',
  lko: 'lucknow', hw: 'haridwar', ynrk: 'rishikesh', rksh: 'rishikesh', rk: 'roorkee',
  bct: 'mumbai', cstm: 'mumbai', bdts: 'mumbai', bom: 'mumbai',
  hwh: 'kolkata', ccu: 'kolkata',
  bsb: 'banaras', varanasi: 'banaras', vns: 'banaras',
  sbc: 'bengaluru', blr: 'bengaluru', bangalore: 'bengaluru',
  mas: 'chennai', maa: 'chennai', hyb: 'hyderabad', hyd: 'hyderabad',
  cdg: 'chandigarh', ixc: 'chandigarh', mao: 'goa', goi: 'goa',
  pune: 'pune', pnq: 'pune', indb: 'indore', idr: 'indore', kgm: 'kathgodam'
};

function matchesTransportCity(queryTerm, cityVal, codeVal) {
  if (!queryTerm) return true;
  const q = queryTerm.trim().toLowerCase();
  const mapped = TRANSPORT_CITY_ALIASES[q] || q;
  return cityVal.toLowerCase().includes(mapped) ||
         codeVal.toLowerCase() === q ||
         cityVal.toLowerCase().includes(q);
}

function registerTransportRoutes(cfg) {
  const { pathPrefix, table, bookingTable, idCol, noCol, carrierCol, priceCol, refPrefix, label } = cfg;

  app.get(`${pathPrefix}`, async (req, res) => {
    try {
      const from = (req.query.from || '').trim();
      const to = (req.query.to || '').trim();
      const travelDate = (req.query.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
      const reqPax = Math.max(1, Math.min(10, parseInt(req.query.passengers, 10) || 1));

      const rowsRes = await query(`
        SELECT t.*, COALESCE(SUM(b.passengers), 0)::int AS booked_seats
        FROM ${table} t
        LEFT JOIN ${bookingTable} b
          ON b.${idCol} = t.id
         AND b.status = 'CONFIRMED'
         AND b.travel_date = $1::date
        GROUP BY t.id
        ORDER BY t.${priceCol} ASC, t.departure_time ASC
      `, [travelDate]);

      const items = rowsRes.rows
        .filter(r => matchesTransportCity(from, r.from_city, r.from_code) && matchesTransportCity(to, r.to_city, r.to_code))
        .map(r => {
          const remainingSeats = Math.max(0, Number(r.seats_total) - Number(r.booked_seats));
          const unitPrice = Number(r[priceCol]);
          return {
            ...r,
            remaining_seats: remainingSeats,
            unit_price: unitPrice,
            estimated_total: unitPrice * reqPax
          };
        })
        .filter(r => r.remaining_seats >= reqPax && r.remaining_seats > 0);

      res.json({ success: true, date: travelDate, passengers: reqPax, items });
    } catch (err) {
      console.error(`GET ${pathPrefix} error:`, err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post(`${pathPrefix}/book`, async (req, res) => {
    try {
      const itemId = parseInt(req.body.item_id, 10);
      const travelDate = (req.body.travel_date || new Date().toISOString().slice(0, 10)).slice(0, 10);
      const passengers = Math.max(1, parseInt(req.body.passengers, 10) || 1);
      const passengerName = (req.body.passenger_name || '').trim();
      const contactMobile = (req.body.contact_mobile || '').trim();
      const cabinClass = (req.body.cabin_class || 'Economy').trim();

      if (!itemId || !passengerName) {
        return res.status(400).json({ success: false, error: 'item_id and passenger_name are required' });
      }

      const itemRes = await query(`SELECT * FROM ${table} WHERE id = $1`, [itemId]);
      if (itemRes.rows.length === 0) {
        return res.status(404).json({ success: false, error: `${label} not found` });
      }
      const item = itemRes.rows[0];

      const bookedRes = await query(`
        SELECT COALESCE(SUM(passengers), 0)::int AS booked
        FROM ${bookingTable}
        WHERE ${idCol} = $1 AND status = 'CONFIRMED' AND travel_date = $2::date
      `, [item.id, travelDate]);
      const remaining = Number(item.seats_total) - Number(bookedRes.rows[0].booked);
      if (remaining < passengers) {
        return res.status(409).json({ success: false, error: `Only ${remaining} seat(s) left for ${travelDate}.` });
      }

      const ref = refPrefix + Math.floor(1000000 + Math.random() * 9000000);
      const totalPrice = Number(item[priceCol]) * passengers;

      const insSql = cfg.hasCabin
        ? `INSERT INTO ${bookingTable} (booking_ref, ${idCol}, ${noCol}, ${carrierCol}, from_city, to_city, travel_date, cabin_class, passengers, passenger_name, contact_mobile, total_price, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'CONFIRMED') RETURNING *`
        : `INSERT INTO ${bookingTable} (booking_ref, ${idCol}, ${noCol}, ${carrierCol}, from_city, to_city, travel_date, passengers, passenger_name, contact_mobile, total_price, status)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'CONFIRMED') RETURNING *`;

      const insParams = cfg.hasCabin
        ? [ref, item.id, item[noCol], item[carrierCol], item.from_city, item.to_city, travelDate, cabinClass, passengers, passengerName, contactMobile, totalPrice]
        : [ref, item.id, item[noCol], item[carrierCol], item.from_city, item.to_city, travelDate, passengers, passengerName, contactMobile, totalPrice];

      const ins = await query(insSql, insParams);
      res.json({
        success: true,
        booking: ins.rows[0],
        remaining_after: remaining - passengers,
        message: `Confirmed ${label} ${item[noCol]} (${item.from_city} → ${item.to_city})! Ref: ${ref}`
      });
    } catch (err) {
      console.error(`POST ${pathPrefix}/book error:`, err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get(`${pathPrefix}/bookings`, async (req, res) => {
    try {
      const bRes = await query(`SELECT * FROM ${bookingTable} ORDER BY id DESC LIMIT 40`);
      res.json({ success: true, bookings: bRes.rows });
    } catch (err) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post(`${pathPrefix}/cancel`, async (req, res) => {
    try {
      const { booking_ref, remove } = req.body;
      if (!booking_ref) return res.status(400).json({ success: false, message: 'booking_ref is required' });

      const result = remove
        ? await query(`DELETE FROM ${bookingTable} WHERE booking_ref = $1 RETURNING *`, [booking_ref])
        : await query(`UPDATE ${bookingTable} SET status = 'CANCELLED' WHERE booking_ref = $1 AND status = 'CONFIRMED' RETURNING *`, [booking_ref]);

      if (result.rows.length === 0) {
        return res.status(404).json({ success: false, message: `Active ${label} booking not found for ${booking_ref}` });
      }
      const row = result.rows[0];
      res.json({
        success: true,
        booking: row,
        message: `${remove ? 'Removed' : 'Cancelled'} ${label} booking ${booking_ref} (${row.from_city} → ${row.to_city}). Seats restored!`
      });
    } catch (err) {
      res.status(500).json({ success: false, message: err.message });
    }
  });
}

registerTransportRoutes({
  pathPrefix: '/api/flights',
  table: 'flights',
  bookingTable: 'flight_bookings',
  idCol: 'flight_id',
  noCol: 'flight_no',
  carrierCol: 'airline',
  priceCol: 'price_economy',
  refPrefix: 'FLT',
  hasCabin: true,
  label: 'Flight'
});

registerTransportRoutes({
  pathPrefix: '/api/buses',
  table: 'buses',
  bookingTable: 'bus_bookings',
  idCol: 'bus_id',
  noCol: 'bus_no',
  carrierCol: 'operator',
  priceCol: 'fare',
  refPrefix: 'BUS',
  hasCabin: false,
  label: 'Bus'
});

// Start Server
async function startServer() {
  try {
    await initDb();
    app.listen(PORT, () => {
      console.log(`=======================================================`);
      console.log(`🚆 RailGo Backend Server running on port ${PORT}`);
      console.log(`=======================================================`);
    });
  } catch (err) {
    console.error('Fatal error starting server:', err);
    process.exit(1);
  }
}

startServer();
