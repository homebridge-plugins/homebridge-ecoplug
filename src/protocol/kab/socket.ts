import * as dgram from 'dgram';
import { KAB_COMMAND_PORT } from '../../settings.js';

interface PendingRequest {
    resolve: (data: Buffer) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
}

class KabSocketManager {
    private socket: dgram.Socket | null = null;
    private bindingData: Promise<void> | null = null;
    private currentError: Error | null = null;
    
    // We only support ONE pending request at a time for a given host:port,
    // or maybe just a global queue. 
    // The safest is to maintain a map of `${rinfo.address}:${rinfo.port}` to an array of pending requests.
    // However, device might reply from a different port? Actually device replies from its command port (usually 1022).
    // Let's just use address as the routing key.
    private pendingRequests = new Map<string, PendingRequest[]>();

    private logFn?: (msg: string) => void;

    public setLogger(log: (msg: string) => void) {
        this.logFn = log;
    }

    private log(msg: string) {
        if (this.logFn) this.logFn(msg);
    }

    private async getSocket(): Promise<dgram.Socket> {
        if (this.socket) { // check if already bound
            return this.socket;
        }
        
        if (this.bindingData) {
            await this.bindingData;
            return this.socket!;
        }

        this.bindingData = new Promise((resolve, reject) => {
            const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
            
            sock.on('error', (err) => {
                this.log(`KAB global socket error: ${err.message}`);
                this.currentError = err;
                this.socket = null;
                this.bindingData = null;
                // Reject all pending requests
                for (const [key, reqs] of this.pendingRequests.entries()) {
                    for (const req of reqs) {
                        clearTimeout(req.timer);
                        req.reject(err);
                    }
                }
                this.pendingRequests.clear();
            });

            sock.on('message', (msg, rinfo) => {
                this.log(`KAB rx ${msg.length}B from ${rinfo.address}:${rinfo.port}: ${msg.toString('hex')}`);
                
                const key = rinfo.address; // route by IP
                const reqs = this.pendingRequests.get(key);
                if (reqs && reqs.length > 0) {
                    const req = reqs.shift()!; // fulfill the oldest request
                    clearTimeout(req.timer);
                    req.resolve(msg);
                } else {
                    this.log(`KAB rx dropped: No pending requests for ${key}`);
                }
            });

            sock.bind(KAB_COMMAND_PORT, () => {
                this.socket = sock;
                this.socket.unref(); // don't block node from exiting
                this.currentError = null;
                this.log(`KAB global socket bound to port ${KAB_COMMAND_PORT}`);
                resolve();
            });
        });

        await this.bindingData;
        return this.socket!;
    }

    public async sendAndReceive(buf: Buffer, host: string, port: number, timeoutMs: number): Promise<Buffer> {
        const sock = await this.getSocket();
        
        return new Promise((resolve, reject) => {
            const key = host;
            
            const timer = setTimeout(() => {
                // remove from queue
                const reqs = this.pendingRequests.get(key);
                if (reqs) {
                    const idx = reqs.indexOf(req);
                    if (idx !== -1) reqs.splice(idx, 1);
                }
                reject(new Error(`KAB command timeout after ${timeoutMs}ms for ${host}:${port}`));
            }, timeoutMs);

            const req: PendingRequest = { resolve, reject, timer };
            
            if (!this.pendingRequests.has(key)) {
                this.pendingRequests.set(key, []);
            }
            this.pendingRequests.get(key)!.push(req);

            this.log(`KAB tx ${buf.length}B to ${host}:${port}: ${buf.toString('hex')}`);
            sock.send(buf, 0, buf.length, port, host, (err) => {
                if (err) {
                    clearTimeout(timer);
                    const reqs = this.pendingRequests.get(key);
                    if (reqs) {
                        const idx = reqs.indexOf(req);
                        if (idx !== -1) reqs.splice(idx, 1);
                    }
                    reject(err);
                }
            });
        });
    }

    public async send(buf: Buffer, host: string, port: number): Promise<void> {
        const sock = await this.getSocket();
        return new Promise((resolve, reject) => {
            sock.send(buf, 0, buf.length, port, host, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }
}

export const kabSocket = new KabSocketManager();
