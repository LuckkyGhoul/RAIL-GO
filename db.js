const path = require('path');
const fs = require('fs');

// Resolve dependencies from extra_files/node_modules if moved
const extraModules = path.join(__dirname, '..', 'extra_files', 'node_modules');
if (fs.existsSync(extraModules) && !module.paths.includes(extraModules)) {
  module.paths.unshift(extraModules);
}

try { require('dotenv').config(); } catch(e) {}

const bcrypt = require('bcryptjs');

let dbClient = null;
let isPgPool = false;

// We support either external PostgreSQL via PG connection pool OR embedded persistent PostgreSQL via PGlite
async function getDb() {
  if (dbClient) return dbClient;

  const databaseUrl = process.env.DATABASE_URL;
  if (databaseUrl) {
    try {
      const { Pool } = require('pg');
      const pool = new Pool({
        connectionString: databaseUrl,
        ssl: databaseUrl.includes('localhost') || databaseUrl.includes('127.0.0.1')
          ? false
          : { rejectUnauthorized: false }
      });
      await pool.query('SELECT 1');
      console.log('✅ Connected to external PostgreSQL via DATABASE_URL');
      dbClient = pool;
      isPgPool = true;
      return dbClient;
    } catch (err) {
      console.warn('⚠️ Could not connect to external PostgreSQL, falling back to embedded persistent PostgreSQL engine:', err.message);
    }
  }

  // Use embedded persistent PostgreSQL (PGlite)
  const { PGlite } = require('@electric-sql/pglite');
  let dataDir = path.join(__dirname, '..', 'data', 'postgres_db');
  if (!fs.existsSync(dataDir)) {
    const extraData = path.join(__dirname, '..', 'extra_files', 'data', 'postgres_db');
    if (fs.existsSync(extraData)) {
      dataDir = extraData;
    } else {
      fs.mkdirSync(dataDir, { recursive: true });
    }
  }

  const pglite = new PGlite(dataDir);
  console.log('✅ Connected to embedded persistent PostgreSQL at', dataDir);
  dbClient = pglite;
  isPgPool = false;
  return dbClient;
}

// Unified query helper
async function query(text, params = []) {
  const db = await getDb();
  if (isPgPool) {
    const res = await db.query(text, params);
    return res;
  } else {
    const res = await db.query(text, params);
    return res;
  }
}

async function exec(sql) {
  const db = await getDb();
  if (isPgPool) {
    return await db.query(sql);
  } else {
    return await db.exec(sql);
  }
}

// Atomic transaction helper for high-concurrency race condition handling
async function transaction(callback) {
  const db = await getDb();
  if (isPgPool) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      const result = await callback(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      try { await client.query('ROLLBACK'); } catch (rbErr) {}
      throw err;
    } finally {
      client.release();
    }
  } else {
    try {
      await db.query('BEGIN');
      const result = await callback(db);
      await db.query('COMMIT');
      return result;
    } catch (err) {
      try { await db.query('ROLLBACK'); } catch (rbErr) {}
      throw err;
    }
  }
}

// Initialize tables and seed data
async function initDb() {
  const db = await getDb();

  console.log('Initializing PostgreSQL database schema...');

  // Create tables using exec for multi-statement DDL
  await exec(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      email VARCHAR(160) UNIQUE NOT NULL,
      mobile VARCHAR(20) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS stations (
      code VARCHAR(10) PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      city VARCHAR(100),
      state VARCHAR(100)
    );

    CREATE TABLE IF NOT EXISTS trains (
      id SERIAL PRIMARY KEY,
      train_no VARCHAR(10) UNIQUE NOT NULL,
      train_name VARCHAR(160) NOT NULL,
      source_code VARCHAR(10),
      dest_code VARCHAR(10),
      departure_time VARCHAR(10) NOT NULL,
      arrival_time VARCHAR(10) NOT NULL,
      duration VARCHAR(20) NOT NULL,
      runs_on VARCHAR(50) DEFAULT 'Daily',
      is_superfast BOOLEAN DEFAULT false,
      has_pantry BOOLEAN DEFAULT false,
      classes TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS train_schedules (
      id SERIAL PRIMARY KEY,
      train_no VARCHAR(10) REFERENCES trains(train_no),
      station_code VARCHAR(10),
      station_name VARCHAR(120) NOT NULL,
      stop_number INT NOT NULL,
      arrival_time VARCHAR(10) NOT NULL,
      departure_time VARCHAR(10) NOT NULL,
      halt_minutes INT DEFAULT 2,
      distance_km INT DEFAULT 0,
      day_count INT DEFAULT 1,
      travel_time_from_start VARCHAR(20) DEFAULT '0m'
    );

    CREATE TABLE IF NOT EXISTS seat_inventory (
      id SERIAL PRIMARY KEY,
      train_no VARCHAR(10) NOT NULL,
      journey_date DATE NOT NULL,
      class_code VARCHAR(10) NOT NULL,
      quota VARCHAR(10) NOT NULL DEFAULT 'GN',
      total_seats INT NOT NULL DEFAULT 50,
      available_seats INT NOT NULL DEFAULT 50,
      booked_seats INT NOT NULL DEFAULT 0,
      wl_count INT NOT NULL DEFAULT 0,
      UNIQUE(train_no, journey_date, class_code, quota)
    );

    CREATE TABLE IF NOT EXISTS bookings (
      id SERIAL PRIMARY KEY,
      pnr VARCHAR(12) UNIQUE NOT NULL,
      user_id INT REFERENCES users(id),
      user_name VARCHAR(120),
      train_no VARCHAR(10) REFERENCES trains(train_no),
      train_name VARCHAR(160) NOT NULL,
      from_station VARCHAR(10),
      to_station VARCHAR(10),
      from_name VARCHAR(120),
      to_name VARCHAR(120),
      departure VARCHAR(10) NOT NULL,
      arrival VARCHAR(10) NOT NULL,
      duration VARCHAR(20) NOT NULL,
      journey_date DATE NOT NULL,
      class_code VARCHAR(10) NOT NULL,
      quota VARCHAR(10) NOT NULL,
      contact_mobile VARCHAR(20) NOT NULL,
      contact_email VARCHAR(160),
      payment_method VARCHAR(50),
      total_fare NUMERIC(10, 2) NOT NULL,
      fare_breakdown TEXT,
      status VARCHAR(30) NOT NULL DEFAULT 'CNF',
      booked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS passengers (
      id SERIAL PRIMARY KEY,
      booking_id INT REFERENCES bookings(id) ON DELETE CASCADE,
      pnr VARCHAR(12) NOT NULL,
      pax_name VARCHAR(120) NOT NULL,
      age INT NOT NULL,
      gender VARCHAR(10) NOT NULL,
      berth_pref VARCHAR(10),
      coach VARCHAR(10),
      berth_no VARCHAR(20),
      status VARCHAR(30) NOT NULL DEFAULT 'CNF'
    );

    CREATE TABLE IF NOT EXISTS refunds (
      id SERIAL PRIMARY KEY,
      pnr VARCHAR(12) NOT NULL,
      refund_ref VARCHAR(40) UNIQUE NOT NULL,
      amount NUMERIC(10, 2) NOT NULL,
      reason VARCHAR(255) NOT NULL,
      status VARCHAR(50) DEFAULT 'INITIATED',
      payment_method VARCHAR(50),
      pax_count INT DEFAULT 1,
      initiated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS hotels (
      id SERIAL PRIMARY KEY,
      city VARCHAR(40) NOT NULL,
      name VARCHAR(120) NOT NULL,
      address VARCHAR(180) NOT NULL,
      rating NUMERIC(2,1) DEFAULT 4.2,
      price_per_night INT NOT NULL,
      max_capacity INT NOT NULL,
      amenities VARCHAR(200),
      UNIQUE(city, name)
    );

    CREATE TABLE IF NOT EXISTS hotel_bookings (
      id SERIAL PRIMARY KEY,
      booking_ref VARCHAR(20) UNIQUE NOT NULL,
      hotel_id INT REFERENCES hotels(id) ON DELETE CASCADE,
      city VARCHAR(40) NOT NULL,
      hotel_name VARCHAR(120) NOT NULL,
      check_in DATE NOT NULL,
      check_out DATE NOT NULL,
      members INT NOT NULL,
      guest_name VARCHAR(120) NOT NULL,
      contact_mobile VARCHAR(20),
      total_price INT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'CONFIRMED',
      booked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS flights (
      id SERIAL PRIMARY KEY,
      flight_no VARCHAR(16) UNIQUE NOT NULL,
      airline VARCHAR(80) NOT NULL,
      from_code VARCHAR(10) NOT NULL,
      to_code VARCHAR(10) NOT NULL,
      from_city VARCHAR(60) NOT NULL,
      to_city VARCHAR(60) NOT NULL,
      departure_time VARCHAR(10) NOT NULL,
      arrival_time VARCHAR(10) NOT NULL,
      duration VARCHAR(20) NOT NULL,
      cabin_classes VARCHAR(60) NOT NULL,
      price_economy INT NOT NULL,
      seats_total INT NOT NULL DEFAULT 60,
      non_stop BOOLEAN DEFAULT true
    );

    CREATE TABLE IF NOT EXISTS flight_bookings (
      id SERIAL PRIMARY KEY,
      booking_ref VARCHAR(20) UNIQUE NOT NULL,
      flight_id INT REFERENCES flights(id) ON DELETE CASCADE,
      flight_no VARCHAR(16) NOT NULL,
      airline VARCHAR(80) NOT NULL,
      from_city VARCHAR(60) NOT NULL,
      to_city VARCHAR(60) NOT NULL,
      travel_date DATE NOT NULL,
      cabin_class VARCHAR(20) NOT NULL DEFAULT 'Economy',
      passengers INT NOT NULL,
      passenger_name VARCHAR(120) NOT NULL,
      contact_mobile VARCHAR(20),
      total_price INT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'CONFIRMED',
      booked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS buses (
      id SERIAL PRIMARY KEY,
      bus_no VARCHAR(20) UNIQUE NOT NULL,
      operator VARCHAR(100) NOT NULL,
      bus_type VARCHAR(60) NOT NULL,
      from_code VARCHAR(10) NOT NULL,
      to_code VARCHAR(10) NOT NULL,
      from_city VARCHAR(60) NOT NULL,
      to_city VARCHAR(60) NOT NULL,
      departure_time VARCHAR(10) NOT NULL,
      arrival_time VARCHAR(10) NOT NULL,
      duration VARCHAR(20) NOT NULL,
      fare INT NOT NULL,
      seats_total INT NOT NULL DEFAULT 40
    );

    CREATE TABLE IF NOT EXISTS bus_bookings (
      id SERIAL PRIMARY KEY,
      booking_ref VARCHAR(20) UNIQUE NOT NULL,
      bus_id INT REFERENCES buses(id) ON DELETE CASCADE,
      bus_no VARCHAR(20) NOT NULL,
      operator VARCHAR(100) NOT NULL,
      from_city VARCHAR(60) NOT NULL,
      to_city VARCHAR(60) NOT NULL,
      travel_date DATE NOT NULL,
      passengers INT NOT NULL,
      passenger_name VARCHAR(120) NOT NULL,
      contact_mobile VARCHAR(20),
      total_price INT NOT NULL,
      status VARCHAR(20) NOT NULL DEFAULT 'CONFIRMED',
      booked_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const migrations = [
    `ALTER TABLE train_schedules ADD COLUMN IF NOT EXISTS travel_time_from_start VARCHAR(20) DEFAULT '0m'`,
    `ALTER TABLE refunds ADD COLUMN IF NOT EXISTS pax_count INT DEFAULT 1`,
    `ALTER TABLE bookings ADD COLUMN IF NOT EXISTS ticket_pid INT`,
    `ALTER TABLE passengers ADD COLUMN IF NOT EXISTS pid INT`,
    `ALTER TABLE passengers ADD COLUMN IF NOT EXISTS tid INT`,
    `ALTER TABLE passengers ADD COLUMN IF NOT EXISTS quota VARCHAR(50)`,
    `ALTER TABLE passengers ADD COLUMN IF NOT EXISTS priority INT`
  ];
  for (const m of migrations) {
    try { await query(m); } catch (e) {}
  }

  console.log('PostgreSQL schema ready. Seeding reference data...');

  // Seed default test user if none exists
  const existingUser = await query(`SELECT id FROM users WHERE email = $1`, ['test@irctc.com']);
  if (existingUser.rows.length === 0) {
    const defaultHash = await bcrypt.hash('irctc123', 10);
    await query(`
      INSERT INTO users (name, email, mobile, password_hash)
      VALUES ($1, $2, $3, $4)
    `, ['Rohan Sharma', 'test@irctc.com', '9876543210', defaultHash]);
    console.log('Seeded default test user: test@irctc.com / irctc123');
  }

  // Seed 20 Hotels across 5 cities (Delhi, Banaras, Goa, Kolkata, Pune)
  // Each city has 4 hotels with max capacities: 3, 4, 6, and 10 guests
  const hotelCntRes = await query(`SELECT COUNT(*)::int AS cnt FROM hotels`);
  if (hotelCntRes.rows[0].cnt < 20) {
    const hotelsSeed = [
      // Delhi
      { city: 'Delhi', name: 'IRCTC Executive Pod (Connaught Place)', address: 'Near New Delhi Railway Station, Gate 2', rating: 4.1, price: 1800, cap: 3, amenities: 'AC, Wi-Fi, 24h Check-in' },
      { city: 'Delhi', name: 'Ginger Rail Yatri Niwas', address: 'Ajmeri Gate, New Delhi', rating: 4.3, price: 2400, cap: 4, amenities: 'AC, Breakfast, Wi-Fi, Station Pickup' },
      { city: 'Delhi', name: 'The Imperial Rail Residency', address: 'Paharganj Main Bazaar, New Delhi', rating: 4.5, price: 3200, cap: 6, amenities: 'Family Suites, AC, Restaurant, Wi-Fi' },
      { city: 'Delhi', name: 'Grand Capital Palace Hotel', address: 'Chanakyapuri Diplomatic Enclave, Delhi', rating: 4.8, price: 4800, cap: 10, amenities: 'Group Halls, Pool, Buffet, Wi-Fi, AC' },
      // Banaras
      { city: 'Banaras', name: 'Kashi Ghat Retiring Suites', address: 'Near Varanasi Cantt Junction', rating: 4.2, price: 1600, cap: 3, amenities: 'AC, Ganga Arti Shuttle, Wi-Fi' },
      { city: 'Banaras', name: 'Dashashwamedh Heritage Inn', address: 'Dashashwamedh Road, Banaras', rating: 4.4, price: 2200, cap: 4, amenities: 'AC, Pure Veg Dining, Wi-Fi' },
      { city: 'Banaras', name: 'Varanasi Ganga View Residency', address: 'Assi Ghat Enclave, Banaras', rating: 4.6, price: 3100, cap: 6, amenities: 'River View, Family Rooms, AC, Wi-Fi' },
      { city: 'Banaras', name: 'Sarnath Royal Grand Hotel', address: 'Cantonment Area, Varanasi', rating: 4.8, price: 4500, cap: 10, amenities: 'Group Dorm & Suites, Pool, Restaurant' },
      // Goa
      { city: 'Goa', name: 'Calangute Beach Cabin', address: 'Calangute Lane 4, North Goa', rating: 4.2, price: 2100, cap: 3, amenities: 'AC, Beach Access, Wi-Fi' },
      { city: 'Goa', name: 'Baga Bay Boutique Stay', address: 'Titos Road, Baga, Goa', rating: 4.4, price: 2900, cap: 4, amenities: 'AC, Pool, Breakfast, Scooter Rental' },
      { city: 'Goa', name: 'Madgaon Express Palms Resort', address: 'Near Madgaon Junction, South Goa', rating: 4.6, price: 3800, cap: 6, amenities: 'Resort Villas, Pool, Wi-Fi, AC' },
      { city: 'Goa', name: 'Coastal Grand Villa Goa', address: 'Candolim Seafront, Goa', rating: 4.9, price: 5500, cap: 10, amenities: '10-Guest Villa, Private Pool, Meals' },
      // Kolkata
      { city: 'Kolkata', name: 'Howrah Bridge Transit Lodge', address: 'Station Road, Howrah, Kolkata', rating: 4.0, price: 1500, cap: 3, amenities: 'AC, 24h Desk, Wi-Fi' },
      { city: 'Kolkata', name: 'Park Street Heritage Suites', address: 'Park Street Metro, Kolkata', rating: 4.4, price: 2300, cap: 4, amenities: 'AC, Breakfast, Wi-Fi, Cafe' },
      { city: 'Kolkata', name: 'Victoria Memorial Residency', address: 'Maidan South, Kolkata', rating: 4.6, price: 3300, cap: 6, amenities: 'City View, Family Suites, Dining, AC' },
      { city: 'Kolkata', name: 'Bengal Grand Imperial Hotel', address: 'Salt Lake Sector V, Kolkata', rating: 4.8, price: 4600, cap: 10, amenities: 'Group Suites, Pool, Buffet, Wi-Fi' },
      // Pune
      { city: 'Pune', name: 'Shivajinagar Rail Stay', address: 'Near Pune Junction, Platform 1 Side', rating: 4.1, price: 1700, cap: 3, amenities: 'AC, Wi-Fi, Express Check-in' },
      { city: 'Pune', name: 'Koregaon Park Comfort Inn', address: 'Lane 6, Koregaon Park, Pune', rating: 4.4, price: 2500, cap: 4, amenities: 'AC, Garden Cafe, Wi-Fi' },
      { city: 'Pune', name: 'Deccan Queen Plaza', address: 'FC Road, Deccan Gymkhana, Pune', rating: 4.6, price: 3400, cap: 6, amenities: 'Family Suites, Dining, AC, Parking' },
      { city: 'Pune', name: 'Sahyadri Grand Convention Hotel', address: 'Viman Nagar, Pune', rating: 4.8, price: 4900, cap: 10, amenities: 'Large Group Capacity, Pool, Buffet' }
    ];

    for (const h of hotelsSeed) {
      await query(`
        INSERT INTO hotels (city, name, address, rating, price_per_night, max_capacity, amenities)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (city, name) DO UPDATE SET
          max_capacity = EXCLUDED.max_capacity,
          price_per_night = EXCLUDED.price_per_night
      `, [h.city, h.name, h.address, h.rating, h.price, h.cap, h.amenities]);
    }
    console.log('✅ Seeded 20 hotels across Delhi, Banaras, Goa, Kolkata, Pune (capacities 3, 4, 6, 10)');
  }

  // Seed Flights aligned with RailGo's stationsList & trainsList network
  const flightCntRes = await query(`SELECT COUNT(*)::int AS cnt FROM flights`);
  if (flightCntRes.rows[0].cnt < 20) {
    const flightsSeed = [
      { no: '6E-2041', airline: 'IndiGo', from: 'DEL', to: 'DED', fCity: 'Delhi', tCity: 'Dehradun', dep: '06:50', arr: '07:45', dur: '0h 55m', cls: 'Economy,Flexi', price: 3250, seats: 60, ns: true },
      { no: 'AI-863',  airline: 'Air India', from: 'DED', to: 'DEL', fCity: 'Dehradun', tCity: 'Delhi', dep: '17:40', arr: '18:35', dur: '0h 55m', cls: 'Economy,Business', price: 3890, seats: 60, ns: true },
      { no: '6E-512',  airline: 'IndiGo', from: 'DED', to: 'LKO', fCity: 'Dehradun', tCity: 'Lucknow', dep: '11:15', arr: '12:35', dur: '1h 20m', cls: 'Economy', price: 4100, seats: 60, ns: true },
      { no: '6E-513',  airline: 'IndiGo', from: 'LKO', to: 'DED', fCity: 'Lucknow', tCity: 'Dehradun', dep: '13:10', arr: '14:30', dur: '1h 20m', cls: 'Economy', price: 4150, seats: 60, ns: true },
      { no: '6E-218',  airline: 'IndiGo', from: 'DEL', to: 'LKO', fCity: 'Delhi', tCity: 'Lucknow', dep: '08:10', arr: '09:20', dur: '1h 10m', cls: 'Economy,Flexi', price: 3450, seats: 60, ns: true },
      { no: 'AI-431',  airline: 'Air India', from: 'LKO', to: 'DEL', fCity: 'Lucknow', tCity: 'Delhi', dep: '19:20', arr: '20:35', dur: '1h 15m', cls: 'Economy,Business', price: 3650, seats: 60, ns: true },
      { no: 'UK-945',  airline: 'Air India (Vistara)', from: 'DEL', to: 'BOM', fCity: 'Delhi', tCity: 'Mumbai', dep: '16:50', arr: '19:05', dur: '2h 15m', cls: 'Economy,Premium,Business', price: 5400, seats: 72, ns: true },
      { no: '6E-6004', airline: 'IndiGo', from: 'BOM', to: 'DEL', fCity: 'Mumbai', tCity: 'Delhi', dep: '07:15', arr: '09:25', dur: '2h 10m', cls: 'Economy,Flexi', price: 5150, seats: 72, ns: true },
      { no: 'AI-762',  airline: 'Air India', from: 'DEL', to: 'CCU', fCity: 'Delhi', tCity: 'Kolkata', dep: '17:10', arr: '19:25', dur: '2h 15m', cls: 'Economy,Business', price: 5600, seats: 66, ns: true },
      { no: '6E-2092', airline: 'IndiGo', from: 'CCU', to: 'DEL', fCity: 'Kolkata', tCity: 'Delhi', dep: '09:40', arr: '12:00', dur: '2h 20m', cls: 'Economy', price: 5300, seats: 66, ns: true },
      { no: 'QP-1305', airline: 'Akasa Air', from: 'DEL', to: 'BLR', fCity: 'Delhi', tCity: 'Bengaluru', dep: '20:15', arr: '23:05', dur: '2h 50m', cls: 'Economy', price: 6200, seats: 66, ns: true },
      { no: 'AI-506',  airline: 'Air India', from: 'DEL', to: 'MAA', fCity: 'Delhi', tCity: 'Chennai', dep: '09:30', arr: '12:20', dur: '2h 50m', cls: 'Economy,Business', price: 6100, seats: 60, ns: true },
      { no: '6E-6511', airline: 'IndiGo', from: 'DEL', to: 'HYD', fCity: 'Delhi', tCity: 'Hyderabad', dep: '14:20', arr: '16:40', dur: '2h 20m', cls: 'Economy', price: 5250, seats: 60, ns: true },
      { no: 'SG-142',  airline: 'SpiceJet', from: 'DEL', to: 'VNS', fCity: 'Delhi', tCity: 'Banaras', dep: '10:30', arr: '11:55', dur: '1h 25m', cls: 'Economy', price: 3950, seats: 54, ns: true },
      { no: '6E-437',  airline: 'IndiGo', from: 'VNS', to: 'DEL', fCity: 'Banaras', tCity: 'Delhi', dep: '15:40', arr: '17:10', dur: '1h 30m', cls: 'Economy', price: 4050, seats: 54, ns: true },
      { no: 'IX-1182', airline: 'Air India Express', from: 'DEL', to: 'GOI', fCity: 'Delhi', tCity: 'Goa', dep: '11:00', arr: '13:35', dur: '2h 35m', cls: 'Economy', price: 5850, seats: 60, ns: true },
      { no: '6E-374',  airline: 'IndiGo', from: 'BOM', to: 'GOI', fCity: 'Mumbai', tCity: 'Goa', dep: '16:15', arr: '17:30', dur: '1h 15m', cls: 'Economy', price: 3100, seats: 60, ns: true },
      { no: '6E-558',  airline: 'IndiGo', from: 'DEL', to: 'PNQ', fCity: 'Delhi', tCity: 'Pune', dep: '18:05', arr: '20:15', dur: '2h 10m', cls: 'Economy,Flexi', price: 4950, seats: 60, ns: true },
      { no: 'AI-644',  airline: 'Air India', from: 'DEL', to: 'IXC', fCity: 'Delhi', tCity: 'Chandigarh', dep: '07:45', arr: '08:45', dur: '1h 00m', cls: 'Economy', price: 2950, seats: 48, ns: true },
      { no: '6E-721',  airline: 'IndiGo', from: 'DEL', to: 'IDR', fCity: 'Delhi', tCity: 'Indore', dep: '12:40', arr: '14:05', dur: '1h 25m', cls: 'Economy', price: 3800, seats: 54, ns: true }
    ];
    for (const f of flightsSeed) {
      await query(`
        INSERT INTO flights (flight_no, airline, from_code, to_code, from_city, to_city, departure_time, arrival_time, duration, cabin_classes, price_economy, seats_total, non_stop)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (flight_no) DO UPDATE SET
          price_economy = EXCLUDED.price_economy,
          from_city = EXCLUDED.from_city,
          to_city = EXCLUDED.to_city
      `, [f.no, f.airline, f.from, f.to, f.fCity, f.tCity, f.dep, f.arr, f.dur, f.cls, f.price, f.seats, f.ns]);
    }
    console.log('✅ Seeded 20 flights across RailGo corridor cities');
  }

  // Seed Buses aligned with RailGo's stationsList & trainsList corridors
  const busCntRes = await query(`SELECT COUNT(*)::int AS cnt FROM buses`);
  if (busCntRes.rows[0].cnt < 20) {
    const busesSeed = [
      { no: 'UK07-VOL-101', op: 'Uttarakhand Transport (UTC Volvo)', type: 'Volvo 9600 AC Seater', from: 'NDLS', to: 'DDN', fCity: 'Delhi', tCity: 'Dehradun', dep: '06:30', arr: '12:15', dur: '5h 45m', fare: 850, seats: 40 },
      { no: 'ZING-ELC-102', op: 'Zingbus Electric AC', type: 'Electric AC Seater (2+2)', from: 'DDN', to: 'NDLS', fCity: 'Dehradun', tCity: 'Delhi', dep: '16:30', arr: '22:10', dur: '5h 40m', fare: 790, seats: 40 },
      { no: 'UK07-AC-103',  op: 'Uttarakhand Transport (UTC)', type: 'AC Janrath Seater', from: 'NDLS', to: 'HW', fCity: 'Delhi', tCity: 'Haridwar', dep: '07:15', arr: '12:00', dur: '4h 45m', fare: 620, seats: 42 },
      { no: 'INTR-SL-104',  op: 'IntrCity SmartBus', type: 'AC Sleeper + Seater', from: 'HW', to: 'NDLS', fCity: 'Haridwar', tCity: 'Delhi', dep: '22:30', arr: '04:00', dur: '5h 30m', fare: 740, seats: 40 },
      { no: 'UK07-EXP-105', op: 'Uttarakhand Transport (UTC)', type: 'Volvo AC Semi-Sleeper', from: 'NDLS', to: 'YNRK', fCity: 'Delhi', tCity: 'Rishikesh', dep: '08:00', arr: '13:30', dur: '5h 30m', fare: 780, seats: 40 },
      { no: 'UK07-SHT-106', op: 'Garhwal Motor Express', type: 'AC Deluxe Seater', from: 'DDN', to: 'HW', fCity: 'Dehradun', tCity: 'Haridwar', dep: '09:00', arr: '10:30', dur: '1h 30m', fare: 180, seats: 44 },
      { no: 'UK07-SHT-107', op: 'Uttarakhand Transport (UTC)', type: 'AC Seater', from: 'NDLS', to: 'RK', fCity: 'Delhi', tCity: 'Roorkee', dep: '10:15', arr: '14:15', dur: '4h 00m', fare: 540, seats: 42 },
      { no: 'UPSR-JAN-201', op: 'UPSRTC Janrath AC', type: 'Janrath AC 2x2', from: 'NDLS', to: 'LKO', fCity: 'Delhi', tCity: 'Lucknow', dep: '21:00', arr: '05:30', dur: '8h 30m', fare: 1050, seats: 40 },
      { no: 'ZING-SL-202',  op: 'Zingbus Maxx Sleeper', type: 'AC Sleeper (2+1)', from: 'LKO', to: 'NDLS', fCity: 'Lucknow', tCity: 'Delhi', dep: '21:30', arr: '05:45', dur: '8h 15m', fare: 1180, seats: 36 },
      { no: 'UPSR-VOL-203', op: 'UPSRTC Pink / Shatabdi Volvo', type: 'Volvo AC Multi-Axle', from: 'LKO', to: 'DDN', fCity: 'Lucknow', tCity: 'Dehradun', dep: '19:30', arr: '07:45', dur: '12h 15m', fare: 1450, seats: 40 },
      { no: 'UPSR-VOL-204', op: 'UPSRTC Shatabdi Volvo', type: 'Volvo AC Seater', from: 'DDN', to: 'LKO', fCity: 'Dehradun', tCity: 'Lucknow', dep: '20:00', arr: '08:15', dur: '12h 15m', fare: 1450, seats: 40 },
      { no: 'UPSR-EXP-205', op: 'UPSRTC Janrath AC', type: 'Janrath AC Seater', from: 'LKO', to: 'BSB', fCity: 'Lucknow', tCity: 'Banaras', dep: '06:45', arr: '12:30', dur: '5h 45m', fare: 690, seats: 42 },
      { no: 'UPSR-EXP-206', op: 'UPSRTC Janrath AC', type: 'Janrath AC Seater', from: 'BSB', to: 'LKO', fCity: 'Banaras', tCity: 'Lucknow', dep: '15:30', arr: '21:15', dur: '5h 45m', fare: 690, seats: 42 },
      { no: 'HRTC-VOL-301', op: 'HRTC / CTU Volvo', type: 'Volvo 9400 AC', from: 'NDLS', to: 'CDG', fCity: 'Delhi', tCity: 'Chandigarh', dep: '07:30', arr: '12:00', dur: '4h 30m', fare: 760, seats: 40 },
      { no: 'HRTC-VOL-302', op: 'CTU Express Volvo', type: 'AC Semi-Sleeper', from: 'CDG', to: 'DDN', fCity: 'Chandigarh', tCity: 'Dehradun', dep: '14:00', arr: '18:00', dur: '4h 00m', fare: 580, seats: 40 },
      { no: 'MSRT-SHV-401', op: 'MSRTC Shivneri Volvo', type: 'Volvo AC Seater', from: 'BCT', to: 'PUNE', fCity: 'Mumbai', tCity: 'Pune', dep: '07:00', arr: '10:30', dur: '3h 30m', fare: 590, seats: 40 },
      { no: 'MSRT-SHV-402', op: 'MSRTC Shivneri Volvo', type: 'Volvo AC Seater', from: 'PUNE', to: 'BCT', fCity: 'Pune', tCity: 'Mumbai', dep: '17:30', arr: '21:00', dur: '3h 30m', fare: 590, seats: 40 },
      { no: 'ZING-GOA-403', op: 'Zingbus / Kadamba AC', type: 'Volvo AC Sleeper', from: 'PUNE', to: 'MAO', fCity: 'Pune', tCity: 'Goa', dep: '21:00', arr: '06:30', dur: '9h 30m', fare: 1350, seats: 36 },
      { no: 'KADM-GOA-404', op: 'Kadamba Transport AC', type: 'AC Sleeper (2+1)', from: 'BCT', to: 'MAO', fCity: 'Mumbai', tCity: 'Goa', dep: '19:45', arr: '07:15', dur: '11h 30m', fare: 1590, seats: 36 },
      { no: 'WBTC-VOL-501', op: 'WBTC Royal Cruiser', type: 'Volvo AC Seater', from: 'HWH', to: 'BSB', fCity: 'Kolkata', tCity: 'Banaras', dep: '18:30', arr: '07:30', dur: '13h 00m', fare: 1420, seats: 40 },
      { no: 'KSRT-AIR-601', op: 'KSRTC Airavat Club Class', type: 'Volvo Multi-Axle AC', from: 'SBC', to: 'MAS', fCity: 'Bengaluru', tCity: 'Chennai', dep: '08:30', arr: '15:00', dur: '6h 30m', fare: 920, seats: 40 },
      { no: 'UK04-KGM-701', op: 'Uttarakhand Transport (UTC)', type: 'AC Janrath Seater', from: 'NDLS', to: 'KGM', fCity: 'Delhi', tCity: 'Kathgodam', dep: '22:00', arr: '04:30', dur: '6h 30m', fare: 790, seats: 42 }
    ];
    for (const b of busesSeed) {
      await query(`
        INSERT INTO buses (bus_no, operator, bus_type, from_code, to_code, from_city, to_city, departure_time, arrival_time, duration, fare, seats_total)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (bus_no) DO UPDATE SET
          fare = EXCLUDED.fare,
          from_city = EXCLUDED.from_city,
          to_city = EXCLUDED.to_city
      `, [b.no, b.op, b.type, b.from, b.to, b.fCity, b.tCity, b.dep, b.arr, b.dur, b.fare, b.seats]);
    }
    console.log('✅ Seeded 22 buses across RailGo station & city corridors');
  }

  // Fast-startup check: skip heavy re-seeding if reference data & today's inventory are already present
  const trainCnt = await query(`SELECT COUNT(*)::int AS cnt FROM trains`);
  const todayStr = new Date().toISOString().slice(0, 10);
  const invCnt = await query(`SELECT COUNT(*)::int AS cnt FROM seat_inventory WHERE journey_date = $1`, [todayStr]);
  if (trainCnt.rows[0].cnt >= 26 && invCnt.rows[0].cnt > 0) {
    console.log('✅ Existing RailGo PostgreSQL data verified. Fast startup!');
    return;
  }

  // 1. Seed Comprehensive Stations (Focus on Dehradun, Haridwar, Lucknow, Rishikesh, Roorkee)
  const stationsList = [
    // Requested Key Stations
    {code:'DDN', name:'Dehradun', city:'Dehradun', state:'Uttarakhand'},
    {code:'HW',  name:'Haridwar Junction', city:'Haridwar', state:'Uttarakhand'},
    {code:'LKO', name:'Lucknow Charbagh', city:'Lucknow', state:'Uttar Pradesh'},
    {code:'YNRK',name:'Yog Nagari Rishikesh', city:'Rishikesh', state:'Uttarakhand'},
    {code:'RKSH',name:'Rishikesh', city:'Rishikesh', state:'Uttarakhand'},
    {code:'RK',  name:'Roorkee', city:'Roorkee', state:'Uttarakhand'},

    // Connecting Rail Arteries
    {code:'SRE', name:'Saharanpur Junction', city:'Saharanpur', state:'Uttar Pradesh'},
    {code:'MOZ', name:'Muzaffarnagar', city:'Muzaffarnagar', state:'Uttar Pradesh'},
    {code:'MTC', name:'Meerut City', city:'Meerut', state:'Uttar Pradesh'},
    {code:'GZB', name:'Ghaziabad Junction', city:'Ghaziabad', state:'Uttar Pradesh'},
    {code:'NDLS',name:'New Delhi', city:'Delhi', state:'Delhi'},
    {code:'NZM', name:'Hazrat Nizamuddin', city:'Delhi', state:'Delhi'},
    {code:'DLI', name:'Delhi Junction', city:'Delhi', state:'Delhi'},
    {code:'DEE', name:'Delhi Sarai Rohilla', city:'Delhi', state:'Delhi'},
    {code:'ANVT',name:'Anand Vihar Terminal', city:'Delhi', state:'Delhi'},

    {code:'MB',  name:'Moradabad Junction', city:'Moradabad', state:'Uttar Pradesh'},
    {code:'BE',  name:'Bareilly Junction', city:'Bareilly', state:'Uttar Pradesh'},
    {code:'SPN', name:'Shahjahanpur', city:'Shahjahanpur', state:'Uttar Pradesh'},
    {code:'HRI', name:'Hardoi', city:'Hardoi', state:'Uttar Pradesh'},
    {code:'CNB', name:'Kanpur Central', city:'Kanpur', state:'Uttar Pradesh'},
    {code:'BSB', name:'Varanasi Junction', city:'Varanasi', state:'Uttar Pradesh'},
    {code:'PYGS',name:'Prayagraj Sangam', city:'Prayagraj', state:'Uttar Pradesh'},
    {code:'ALD', name:'Prayagraj Junction', city:'Prayagraj', state:'Uttar Pradesh'},
    {code:'GKP', name:'Gorakhpur Junction', city:'Gorakhpur', state:'Uttar Pradesh'},

    {code:'UMB', name:'Ambala Cantt', city:'Ambala', state:'Haryana'},
    {code:'CDG', name:'Chandigarh Junction', city:'Chandigarh', state:'Chandigarh'},
    {code:'JAT', name:'Jammu Tawi', city:'Jammu', state:'Jammu & Kashmir'},
    {code:'SVDK',name:'Shri Mata Vaishno Devi Katra', city:'Katra', state:'Jammu & Kashmir'},

    {code:'BCT', name:'Mumbai Central', city:'Mumbai', state:'Maharashtra'},
    {code:'CSTM',name:'Mumbai CSMT', city:'Mumbai', state:'Maharashtra'},
    {code:'BDTS',name:'Bandra Terminus', city:'Mumbai', state:'Maharashtra'},
    {code:'HWH', name:'Howrah Junction', city:'Kolkata', state:'West Bengal'},
    {code:'SBC', name:'KSR Bengaluru City', city:'Bengaluru', state:'Karnataka'},
    {code:'MAS', name:'Chennai Central', city:'Chennai', state:'Tamil Nadu'},
    {code:'HYB', name:'Hyderabad Deccan', city:'Hyderabad', state:'Telangana'},
    {code:'KOTA',name:'Kota Junction', city:'Kota', state:'Rajasthan'},
    {code:'RTM', name:'Ratlam Junction', city:'Ratlam', state:'Madhya Pradesh'},
    {code:'ST',  name:'Surat', city:'Surat', state:'Gujarat'},
    {code:'BRC', name:'Vadodara Junction', city:'Vadodara', state:'Gujarat'},
    {code:'INDB',name:'Indore Junction', city:'Indore', state:'Madhya Pradesh'},
    {code:'BPL', name:'Bhopal Junction', city:'Bhopal', state:'Madhya Pradesh'},
    {code:'MAO', name:'Madgaon Junction', city:'Goa', state:'Goa'},
    {code:'KGM', name:'Kathgodam', city:'Kathgodam', state:'Uttarakhand'},
  ];

  for (const s of stationsList) {
    await query(`
      INSERT INTO stations (code, name, city, state)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (code) DO NOTHING
    `, [s.code, s.name, s.city, s.state]);
  }

  // 2. Seed Trains (Covering Dehradun, Haridwar, Lucknow, Rishikesh, Roorkee)
  const trainsList = [
    // Dehradun / Haridwar / Roorkee <-> New Delhi
    {
      num: '12017', name: 'Dehradun Shatabdi Express',
      from: 'NDLS', to: 'DDN',
      dep: '06:45', arr: '12:55', dur: '6h 10m',
      runs: 'Daily', sf: true, pantry: true, classes: 'CC,EC'
    },
    {
      num: '12018', name: 'Dehradun New Delhi Shatabdi',
      from: 'DDN', to: 'NDLS',
      dep: '17:00', arr: '22:50', dur: '5h 50m',
      runs: 'Daily', sf: true, pantry: true, classes: 'CC,EC'
    },
    {
      num: '12055', name: 'Dehradun Jan Shatabdi Express',
      from: 'NDLS', to: 'DDN',
      dep: '15:20', arr: '21:10', dur: '5h 50m',
      runs: 'Daily', sf: true, pantry: false, classes: '2S,CC'
    },
    {
      num: '12056', name: 'Dehradun New Delhi Jan Shatabdi',
      from: 'DDN', to: 'NDLS',
      dep: '05:00', arr: '11:05', dur: '6h 05m',
      runs: 'Daily', sf: true, pantry: false, classes: '2S,CC'
    },

    // Lucknow <-> Dehradun / Haridwar / Roorkee
    {
      num: '14265', name: 'Varanasi - Dehradun Janta Express',
      from: 'LKO', to: 'DDN',
      dep: '16:15', arr: '06:30', dur: '14h 15m',
      runs: 'Daily', sf: false, pantry: false, classes: 'SL,3A,2A'
    },
    {
      num: '14266', name: 'Dehradun - Varanasi Janta Express',
      from: 'DDN', to: 'LKO',
      dep: '18:15', arr: '08:45', dur: '14h 30m',
      runs: 'Daily', sf: false, pantry: false, classes: 'SL,3A,2A'
    },
    {
      num: '13009', name: 'Doon Express',
      from: 'LKO', to: 'DDN',
      dep: '17:55', arr: '07:35', dur: '13h 40m',
      runs: 'Daily', sf: false, pantry: true, classes: 'SL,3A,2A,1A'
    },
    {
      num: '13010', name: 'Doon Express (Return)',
      from: 'DDN', to: 'LKO',
      dep: '20:15', arr: '09:20', dur: '13h 05m',
      runs: 'Daily', sf: false, pantry: true, classes: 'SL,3A,2A,1A'
    },

    // Rishikesh / Haridwar / Roorkee Trains
    {
      num: '14609', name: 'Hemkunt Express',
      from: 'YNRK', to: 'SVDK',
      dep: '17:20', arr: '07:10', dur: '13h 50m',
      runs: 'Daily', sf: false, pantry: false, classes: 'SL,3A,2A'
    },
    {
      num: '14610', name: 'Hemkunt Express (Return)',
      from: 'RK', to: 'YNRK',
      dep: '06:20', arr: '08:30', dur: '2h 10m',
      runs: 'Daily', sf: false, pantry: false, classes: 'SL,3A,2A'
    },
    {
      num: '14229', name: 'Prayag - Yog Nagari Rishikesh Express',
      from: 'LKO', to: 'YNRK',
      dep: '04:10', arr: '14:30', dur: '10h 20m',
      runs: 'Tue,Thu,Sun', sf: false, pantry: false, classes: 'SL,3A,2A'
    },
    {
      num: '14230', name: 'Yog Nagari Rishikesh - Prayag Express',
      from: 'YNRK', to: 'LKO',
      dep: '15:20', arr: '01:40', dur: '10h 20m',
      runs: 'Mon,Wed,Fri', sf: false, pantry: false, classes: 'SL,3A,2A'
    },

    // Lucknow <-> Roorkee / Chandigarh / New Delhi
    {
      num: '12231', name: 'Lucknow - Chandigarh Express',
      from: 'LKO', to: 'CDG',
      dep: '22:25', arr: '10:05', dur: '11h 40m',
      runs: 'Daily', sf: true, pantry: true, classes: 'SL,3A,2A,1A'
    },
    {
      num: '12429', name: 'Lucknow AC Superfast Express',
      from: 'LKO', to: 'NDLS',
      dep: '23:30', arr: '07:30', dur: '8h 00m',
      runs: 'Daily', sf: true, pantry: false, classes: '3A,2A,1A'
    },
    {
      num: '12430', name: 'New Delhi - Lucknow AC Superfast',
      from: 'NDLS', to: 'LKO',
      dep: '23:25', arr: '07:15', dur: '7h 50m',
      runs: 'Daily', sf: true, pantry: false, classes: '3A,2A,1A'
    },

    // Major National Trunks
    {
      num: '12951', name: 'Mumbai Rajdhani Express',
      from: 'NDLS', to: 'BCT',
      dep: '16:55', arr: '08:35', dur: '15h 40m',
      runs: 'Daily', sf: true, pantry: true, classes: '1A,2A,3A'
    },
    {
      num: '12952', name: 'New Delhi Rajdhani Express',
      from: 'BCT', to: 'NDLS',
      dep: '17:00', arr: '08:35', dur: '15h 35m',
      runs: 'Daily', sf: true, pantry: true, classes: '1A,2A,3A'
    },
    {
      num: '12301', name: 'Howrah Rajdhani Express',
      from: 'NDLS', to: 'HWH',
      dep: '17:00', arr: '10:05', dur: '17h 05m',
      runs: 'Daily', sf: true, pantry: true, classes: '1A,2A,3A'
    },
    {
      num: '12001', name: 'Bhopal Shatabdi Express',
      from: 'NDLS', to: 'BPL',
      dep: '06:00', arr: '14:00', dur: '8h 00m',
      runs: 'Daily', sf: true, pantry: true, classes: 'EC,CC'
    },
    {
      num: '12627', name: 'Karnataka Express',
      from: 'NDLS', to: 'SBC',
      dep: '22:30', arr: '10:45', dur: '36h 15m',
      runs: 'Daily', sf: false, pantry: true, classes: 'SL,3A,2A,1A'
    }
  ];

  for (const t of trainsList) {
    await query(`
      INSERT INTO trains (train_no, train_name, source_code, dest_code, departure_time, arrival_time, duration, runs_on, is_superfast, has_pantry, classes)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      ON CONFLICT (train_no) DO UPDATE SET
        train_name = EXCLUDED.train_name,
        source_code = EXCLUDED.source_code,
        dest_code = EXCLUDED.dest_code,
        departure_time = EXCLUDED.departure_time,
        arrival_time = EXCLUDED.arrival_time,
        duration = EXCLUDED.duration,
        classes = EXCLUDED.classes
    `, [t.num, t.name, t.from, t.to, t.dep, t.arr, t.dur, t.runs, t.sf, t.pantry, t.classes]);
  }

  // 3. Seed Detailed Train Schedules (Default station reaching times & cumulative travel times)
  const schedules = [
    // 12017: NDLS -> DDN (via Roorkee & Haridwar)
    {train_no: '12017', station_code: 'NDLS', station_name: 'New Delhi', stop_number: 1, arrival_time: 'START', departure_time: '06:45', halt_minutes: 0, distance_km: 0, day_count: 1, travel_time_from_start: '0m'},
    {train_no: '12017', station_code: 'GZB',  station_name: 'Ghaziabad Junction', stop_number: 2, arrival_time: '07:21', departure_time: '07:23', halt_minutes: 2, distance_km: 26, day_count: 1, travel_time_from_start: '36m'},
    {train_no: '12017', station_code: 'MTC',  station_name: 'Meerut City', stop_number: 3, arrival_time: '08:01', departure_time: '08:03', halt_minutes: 2, distance_km: 72, day_count: 1, travel_time_from_start: '1h 16m'},
    {train_no: '12017', station_code: 'MOZ',  station_name: 'Muzaffarnagar', stop_number: 4, arrival_time: '08:41', departure_time: '08:43', halt_minutes: 2, distance_km: 128, day_count: 1, travel_time_from_start: '1h 56m'},
    {train_no: '12017', station_code: 'SRE',  station_name: 'Saharanpur Junction', stop_number: 5, arrival_time: '09:50', departure_time: '10:15', halt_minutes: 25, distance_km: 186, day_count: 1, travel_time_from_start: '3h 05m'},
    {train_no: '12017', station_code: 'RK',   station_name: 'Roorkee', stop_number: 6, arrival_time: '10:47', departure_time: '10:49', halt_minutes: 2, distance_km: 221, day_count: 1, travel_time_from_start: '4h 02m'},
    {train_no: '12017', station_code: 'HW',   station_name: 'Haridwar Junction', stop_number: 7, arrival_time: '11:33', departure_time: '11:38', halt_minutes: 5, distance_km: 266, day_count: 1, travel_time_from_start: '4h 48m'},
    {train_no: '12017', station_code: 'DDN',  station_name: 'Dehradun', stop_number: 8, arrival_time: '12:55', departure_time: 'ENDS', halt_minutes: 0, distance_km: 318, day_count: 1, travel_time_from_start: '6h 10m'},

    // 12018: DDN -> NDLS (via Haridwar & Roorkee)
    {train_no: '12018', station_code: 'DDN',  station_name: 'Dehradun', stop_number: 1, arrival_time: 'START', departure_time: '17:00', halt_minutes: 0, distance_km: 0, day_count: 1, travel_time_from_start: '0m'},
    {train_no: '12018', station_code: 'HW',   station_name: 'Haridwar Junction', stop_number: 2, arrival_time: '18:10', departure_time: '18:15', halt_minutes: 5, distance_km: 52, day_count: 1, travel_time_from_start: '1h 10m'},
    {train_no: '12018', station_code: 'RK',   station_name: 'Roorkee', stop_number: 3, arrival_time: '18:58', departure_time: '19:00', halt_minutes: 2, distance_km: 97, day_count: 1, travel_time_from_start: '1h 58m'},
    {train_no: '12018', station_code: 'SRE',  station_name: 'Saharanpur Junction', stop_number: 4, arrival_time: '19:40', departure_time: '20:00', halt_minutes: 20, distance_km: 132, day_count: 1, travel_time_from_start: '2h 40m'},
    {train_no: '12018', station_code: 'MOZ',  station_name: 'Muzaffarnagar', stop_number: 5, arrival_time: '20:41', departure_time: '20:43', halt_minutes: 2, distance_km: 190, day_count: 1, travel_time_from_start: '3h 41m'},
    {train_no: '12018', station_code: 'MTC',  station_name: 'Meerut City', stop_number: 6, arrival_time: '21:22', departure_time: '21:24', halt_minutes: 2, distance_km: 246, day_count: 1, travel_time_from_start: '4h 22m'},
    {train_no: '12018', station_code: 'GZB',  station_name: 'Ghaziabad Junction', stop_number: 7, arrival_time: '22:02', departure_time: '22:04', halt_minutes: 2, distance_km: 292, day_count: 1, travel_time_from_start: '5h 02m'},
    {train_no: '12018', station_code: 'NDLS', station_name: 'New Delhi', stop_number: 8, arrival_time: '22:50', departure_time: 'ENDS', halt_minutes: 0, distance_km: 318, day_count: 1, travel_time_from_start: '5h 50m'},

    // 14265: Varanasi/Lucknow -> Dehradun (via Bareilly, Moradabad, Roorkee, Haridwar)
    {train_no: '14265', station_code: 'LKO',  station_name: 'Lucknow Charbagh', stop_number: 1, arrival_time: 'START', departure_time: '16:15', halt_minutes: 0, distance_km: 0, day_count: 1, travel_time_from_start: '0m'},
    {train_no: '14265', station_code: 'HRI',  station_name: 'Hardoi', stop_number: 2, arrival_time: '17:50', departure_time: '17:55', halt_minutes: 5, distance_km: 101, day_count: 1, travel_time_from_start: '1h 35m'},
    {train_no: '14265', station_code: 'SPN',  station_name: 'Shahjahanpur', stop_number: 3, arrival_time: '19:10', departure_time: '19:15', halt_minutes: 5, distance_km: 164, day_count: 1, travel_time_from_start: '2h 55m'},
    {train_no: '14265', station_code: 'BE',   station_name: 'Bareilly Junction', stop_number: 4, arrival_time: '20:30', departure_time: '20:35', halt_minutes: 5, distance_km: 235, day_count: 1, travel_time_from_start: '4h 15m'},
    {train_no: '14265', station_code: 'MB',   station_name: 'Moradabad Junction', stop_number: 5, arrival_time: '22:15', departure_time: '22:25', halt_minutes: 10, distance_km: 325, day_count: 1, travel_time_from_start: '6h 00m'},
    {train_no: '14265', station_code: 'RK',   station_name: 'Roorkee', stop_number: 6, arrival_time: '03:15', departure_time: '03:20', halt_minutes: 5, distance_km: 467, day_count: 2, travel_time_from_start: '11h 00m'},
    {train_no: '14265', station_code: 'HW',   station_name: 'Haridwar Junction', stop_number: 7, arrival_time: '04:15', departure_time: '04:25', halt_minutes: 10, distance_km: 508, day_count: 2, travel_time_from_start: '12h 00m'},
    {train_no: '14265', station_code: 'DDN',  station_name: 'Dehradun', stop_number: 8, arrival_time: '06:30', departure_time: 'ENDS', halt_minutes: 0, distance_km: 560, day_count: 2, travel_time_from_start: '14h 15m'},

    // 14266: Dehradun -> Lucknow (via Haridwar, Roorkee, Moradabad, Bareilly)
    {train_no: '14266', station_code: 'DDN',  station_name: 'Dehradun', stop_number: 1, arrival_time: 'START', departure_time: '18:15', halt_minutes: 0, distance_km: 0, day_count: 1, travel_time_from_start: '0m'},
    {train_no: '14266', station_code: 'HW',   station_name: 'Haridwar Junction', stop_number: 2, arrival_time: '19:35', departure_time: '19:45', halt_minutes: 10, distance_km: 52, day_count: 1, travel_time_from_start: '1h 20m'},
    {train_no: '14266', station_code: 'RK',   station_name: 'Roorkee', stop_number: 3, arrival_time: '20:38', departure_time: '20:40', halt_minutes: 2, distance_km: 93, day_count: 1, travel_time_from_start: '2h 23m'},
    {train_no: '14266', station_code: 'MB',   station_name: 'Moradabad Junction', stop_number: 4, arrival_time: '01:05', departure_time: '01:15', halt_minutes: 10, distance_km: 235, day_count: 2, travel_time_from_start: '6h 50m'},
    {train_no: '14266', station_code: 'BE',   station_name: 'Bareilly Junction', stop_number: 5, arrival_time: '02:50', departure_time: '02:55', halt_minutes: 5, distance_km: 325, day_count: 2, travel_time_from_start: '8h 35m'},
    {train_no: '14266', station_code: 'LKO',  station_name: 'Lucknow Charbagh', stop_number: 6, arrival_time: '08:45', departure_time: 'ENDS', halt_minutes: 0, distance_km: 560, day_count: 2, travel_time_from_start: '14h 30m'},

    // 14609: Hemkunt Express (YNRK Rishikesh -> Haridwar -> Roorkee -> Katra)
    {train_no: '14609', station_code: 'YNRK', station_name: 'Yog Nagari Rishikesh', stop_number: 1, arrival_time: 'START', departure_time: '17:20', halt_minutes: 0, distance_km: 0, day_count: 1, travel_time_from_start: '0m'},
    {train_no: '14609', station_code: 'HW',   station_name: 'Haridwar Junction', stop_number: 2, arrival_time: '18:15', departure_time: '18:25', halt_minutes: 10, distance_km: 23, day_count: 1, travel_time_from_start: '55m'},
    {train_no: '14609', station_code: 'RK',   station_name: 'Roorkee', stop_number: 3, arrival_time: '19:08', departure_time: '19:10', halt_minutes: 2, distance_km: 65, day_count: 1, travel_time_from_start: '1h 48m'},
    {train_no: '14609', station_code: 'SRE',  station_name: 'Saharanpur Junction', stop_number: 4, arrival_time: '19:55', departure_time: '20:05', halt_minutes: 10, distance_km: 99, day_count: 1, travel_time_from_start: '2h 35m'},
    {train_no: '14609', station_code: 'UMB',  station_name: 'Ambala Cantt', stop_number: 5, arrival_time: '21:15', departure_time: '21:20', halt_minutes: 5, distance_km: 180, day_count: 1, travel_time_from_start: '3h 55m'},
    {train_no: '14609', station_code: 'JAT',  station_name: 'Jammu Tawi', stop_number: 6, arrival_time: '04:50', departure_time: '05:00', halt_minutes: 10, distance_km: 557, day_count: 2, travel_time_from_start: '11h 30m'},
    {train_no: '14609', station_code: 'SVDK', station_name: 'Shri Mata Vaishno Devi Katra', stop_number: 7, arrival_time: '07:10', departure_time: 'ENDS', halt_minutes: 0, distance_km: 635, day_count: 2, travel_time_from_start: '13h 50m'},

    // 14229: Prayag - Rishikesh Express (via Lucknow, Roorkee, Haridwar)
    {train_no: '14229', station_code: 'LKO',  station_name: 'Lucknow Charbagh', stop_number: 1, arrival_time: 'START', departure_time: '04:10', halt_minutes: 0, distance_km: 0, day_count: 1, travel_time_from_start: '0m'},
    {train_no: '14229', station_code: 'BE',   station_name: 'Bareilly Junction', stop_number: 2, arrival_time: '07:55', departure_time: '08:00', halt_minutes: 5, distance_km: 235, day_count: 1, travel_time_from_start: '3h 45m'},
    {train_no: '14229', station_code: 'MB',   station_name: 'Moradabad Junction', stop_number: 3, arrival_time: '09:35', departure_time: '09:45', halt_minutes: 10, distance_km: 325, day_count: 1, travel_time_from_start: '5h 25m'},
    {train_no: '14229', station_code: 'RK',   station_name: 'Roorkee', stop_number: 4, arrival_time: '12:28', departure_time: '12:30', halt_minutes: 2, distance_km: 467, day_count: 1, travel_time_from_start: '8h 18m'},
    {train_no: '14229', station_code: 'HW',   station_name: 'Haridwar Junction', stop_number: 5, arrival_time: '13:20', departure_time: '13:30', halt_minutes: 10, distance_km: 508, day_count: 1, travel_time_from_start: '9h 10m'},
    {train_no: '14229', station_code: 'YNRK', station_name: 'Yog Nagari Rishikesh', stop_number: 6, arrival_time: '14:30', departure_time: 'ENDS', halt_minutes: 0, distance_km: 531, day_count: 1, travel_time_from_start: '10h 20m'},

    // 12429: Lucknow AC Superfast (Lucknow -> New Delhi)
    {train_no: '12429', station_code: 'LKO',  station_name: 'Lucknow Charbagh', stop_number: 1, arrival_time: 'START', departure_time: '23:30', halt_minutes: 0, distance_km: 0, day_count: 1, travel_time_from_start: '0m'},
    {train_no: '12429', station_code: 'BE',   station_name: 'Bareilly Junction', stop_number: 2, arrival_time: '02:58', departure_time: '03:00', halt_minutes: 2, distance_km: 235, day_count: 2, travel_time_from_start: '3h 28m'},
    {train_no: '12429', station_code: 'MB',   station_name: 'Moradabad Junction', stop_number: 3, arrival_time: '04:30', departure_time: '04:35', halt_minutes: 5, distance_km: 325, day_count: 2, travel_time_from_start: '5h 00m'},
    {train_no: '12429', station_code: 'GZB',  station_name: 'Ghaziabad Junction', stop_number: 4, arrival_time: '06:45', departure_time: '06:47', halt_minutes: 2, distance_km: 466, day_count: 2, travel_time_from_start: '7h 15m'},
    {train_no: '12429', station_code: 'NDLS', station_name: 'New Delhi', stop_number: 5, arrival_time: '07:30', departure_time: 'ENDS', halt_minutes: 0, distance_km: 492, day_count: 2, travel_time_from_start: '8h 00m'},

    // 12951: Mumbai Rajdhani NDLS -> BCT
    {train_no: '12951', station_code: 'NDLS', station_name: 'New Delhi', stop_number: 1, arrival_time: 'START', departure_time: '16:55', halt_minutes: 0, distance_km: 0, day_count: 1, travel_time_from_start: '0m'},
    {train_no: '12951', station_code: 'KOTA', station_name: 'Kota Junction', stop_number: 2, arrival_time: '21:25', departure_time: '21:35', halt_minutes: 10, distance_km: 466, day_count: 1, travel_time_from_start: '4h 30m'},
    {train_no: '12951', station_code: 'RTM',  station_name: 'Ratlam Junction', stop_number: 3, arrival_time: '01:03', departure_time: '01:05', halt_minutes: 2, distance_km: 733, day_count: 2, travel_time_from_start: '8h 08m'},
    {train_no: '12951', station_code: 'BRC',  station_name: 'Vadodara Junction', stop_number: 4, arrival_time: '04:22', departure_time: '04:30', halt_minutes: 8, distance_km: 993, day_count: 2, travel_time_from_start: '11h 27m'},
    {train_no: '12951', station_code: 'ST',   station_name: 'Surat', stop_number: 5, arrival_time: '05:58', departure_time: '06:03', halt_minutes: 5, distance_km: 1123, day_count: 2, travel_time_from_start: '13h 03m'},
    {train_no: '12951', station_code: 'BCT',  station_name: 'Mumbai Central', stop_number: 6, arrival_time: '08:35', departure_time: 'ENDS', halt_minutes: 0, distance_km: 1386, day_count: 2, travel_time_from_start: '15h 40m'},
  ];

  for (const sc of schedules) {
    const existing = await query(`
      SELECT id FROM train_schedules
      WHERE train_no = $1 AND station_code = $2 AND stop_number = $3
    `, [sc.train_no, sc.station_code, sc.stop_number]);

    if (existing.rows.length === 0) {
      await query(`
        INSERT INTO train_schedules (train_no, station_code, station_name, stop_number, arrival_time, departure_time, halt_minutes, distance_km, day_count, travel_time_from_start)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      `, [sc.train_no, sc.station_code, sc.station_name, sc.stop_number, sc.arrival_time, sc.departure_time, sc.halt_minutes, sc.distance_km, sc.day_count, sc.travel_time_from_start || '0m']);
    } else {
      await query(`
        UPDATE train_schedules
        SET arrival_time = $1, departure_time = $2, halt_minutes = $3, distance_km = $4, travel_time_from_start = $5
        WHERE train_no = $6 AND station_code = $7 AND stop_number = $8
      `, [sc.arrival_time, sc.departure_time, sc.halt_minutes, sc.distance_km, sc.travel_time_from_start || '0m', sc.train_no, sc.station_code, sc.stop_number]);
    }
  }

  // 4. Seed Live Seat Inventory for demonstration of Race Condition and dynamic seat decrement
  // Default small capacity (< 12 seats) so larger bookings trigger race condition!
  // Green tiers: Available seats < 12 (e.g. 2, 4, 5, 6)
  // Yellow tiers: Waiting list (available_seats = 0, wl_count > 0)
  const today = new Date().toISOString().slice(0, 10);
  const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
  const dayAfter = new Date(Date.now() + 86400000 * 2).toISOString().slice(0, 10);

  const datesToSeed = [today, tomorrow, dayAfter];
  for (const d of datesToSeed) {
    for (const t of trainsList) {
      const classArr = t.classes.split(',');
      for (const cls of classArr) {
        const def = getDefaultTierSeats(cls);
        await query(`
          INSERT INTO seat_inventory (train_no, journey_date, class_code, quota, total_seats, available_seats, booked_seats, wl_count)
          VALUES ($1, $2, $3, 'GN', 50, $4, 0, $5)
          ON CONFLICT (train_no, journey_date, class_code, quota) DO UPDATE SET
            available_seats = EXCLUDED.available_seats,
            wl_count = EXCLUDED.wl_count
          WHERE seat_inventory.booked_seats = 0
        `, [t.num, d, cls, def.available, def.wl]);
      }
    }
  }

  console.log('✅ PostgreSQL database initialization, expanded trains, and seat inventory completed!');
}

function getDefaultTierSeats(classCode) {
  // Available seats must be less than max passengers in booking (e.g. < 12)
  // Yellow tiers: in Waiting list (available_seats = 0, wl_count > 0)
  // Green tiers: available seats (e.g. 2, 4, 5, 6 seats < 12)
  if (['2A', 'EC'].includes(classCode)) {
    return { available: 0, wl: 3 }; // Yellow (Waiting List)
  }
  if (['1A'].includes(classCode)) {
    return { available: 2, wl: 0 }; // Green (< 12)
  }
  if (['3A'].includes(classCode)) {
    return { available: 6, wl: 0 }; // Green (< 12)
  }
  if (['2S'].includes(classCode)) {
    return { available: 5, wl: 0 }; // Green (< 12)
  }
  // Default for CC, SL, etc.
  return { available: 4, wl: 0 }; // Green (< 12)
}

module.exports = {
  getDb,
  query,
  exec,
  transaction,
  initDb,
  getDefaultTierSeats
};
