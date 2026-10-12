const mysql = require('mysql2/promise');
require('dotenv').config();

const pool = mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'nexa',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

async function testConnection() {
    let connection;

    try {
        connection = await pool.getConnection();

        const [rows] = await connection.query(`
            SELECT
                DATABASE() AS database_name,
                @@hostname AS server_host,
                @@port AS server_port
        `);

        console.log('NEXA MySQL database connected successfully!');
        console.log('Connected database:', rows[0].database_name);
        console.log('MySQL server:', rows[0].server_host);
        console.log('MySQL port:', rows[0].server_port);

        const [columns] = await connection.query(`
            SHOW COLUMNS FROM users LIKE 'verification_expires_at'
        `);

        console.log(
            'Verification expiry column exists:',
            columns.length > 0
        );
    } catch (error) {
        console.error('NEXA database diagnostic failed:', error.message);
    } finally {
        if (connection) {
            connection.release();
        }
    }
}

module.exports = { pool, testConnection };