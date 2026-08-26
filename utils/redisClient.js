const { createClient } = require('redis');

/**
 * Optional Redis connection (phase-2 caching for read-heavy commands).
 * The /signup write path does NOT require Redis; the bot runs fine without it.
 */
class RedisClient {
    constructor() {
        this.client = null;
        this.isConnected = false;
    }

    async connect() {
        if (this.isConnected) return this.client;

        this.client = createClient({
            url: process.env.REDISCLOUD_URL
        });

        this.client.on('error', (err) => {
            console.error('Redis Client Error:', err);
            this.isConnected = false;
        });

        this.client.on('connect', () => {
            console.log('Connected to Redis');
            this.isConnected = true;
        });

        this.client.on('disconnect', () => {
            console.log('Disconnected from Redis');
            this.isConnected = false;
        });

        await this.client.connect();
        return this.client;
    }

    async disconnect() {
        if (this.client && this.isConnected) {
            await this.client.disconnect();
            this.isConnected = false;
        }
    }

    getClient() {
        return this.client;
    }

    isReady() {
        return this.isConnected && this.client;
    }
}

module.exports = new RedisClient();
