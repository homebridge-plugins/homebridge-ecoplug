import * as dgram from 'dgram';
import { KAB_COMMAND_PORT } from '../../settings.js';

interface PendingRequest {
    resolve: (data: Buffer) => void;
    reject: (err: Error) => void;
}

interface PendingGroup {
    reqs: PendingRequest[];
    timer: NodeJS.Timeout;
}

class KabSocketManager {
    private socket: dgram.Socket | null = null;
    private bindingData: Promise<void> | null = null;
    private currentError: Error | null = null;
    
    /** Port to bind the socket to; defaults to KAB_COMMAND_PORT but can be
     * overridden via configuration.  Setting to 0 tells the OS to choose an
     * ephemeral port. */
    private bindPort: number = KAB_COMMAND_PORT;

    /** Override the source port used for KAB commands.  Call before sending
     * any commands (e.g. from platform initialization). */
    public setBindPort(port: number) {
        this.bindPort = port;
        // if socket already exists, user should restart Homebridge for simplicity
    }
    
    // pendingGroups maps a unique group key (host:port:bufHex) to all callers
    // that piggybacked that exact outgoing buffer.  pendingQueue preserves
    // send order per-host so responses are demultiplexed FIFO.
    private pendingGroups = new Map<string, PendingGroup>();
    private pendingQueue  = new Map<string, string[]>(); // host -> [groupKey,...]

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
                // Reject all pending groups
                for (const [key, grp] of this.pendingGroups.entries()) {
                    clearTimeout(grp.timer);
                    for (const req of grp.reqs) req.reject(err);
                }
                this.pendingGroups.clear();
                this.pendingQueue.clear();
            });

            sock.on('message', (msg, rinfo) => {
                this.log(`KAB rx ${msg.length}B from ${rinfo.address}:${rinfo.port}: ${msg.toString('hex')}`);
                const host = rinfo.address;
                const queue = this.pendingQueue.get(host);
                if (queue && queue.length > 0) {
                    const groupKey = queue.shift()!;
                    const group = this.pendingGroups.get(groupKey);
                    if (group) {
                        clearTimeout(group.timer);
                        for (const req of group.reqs) {
                            req.resolve(msg);
                        }
                        this.pendingGroups.delete(groupKey);
                    } else {
                        this.log(`KAB rx dropped: No pending group for ${groupKey}`);
                    }
                } else {
                    this.log(`KAB rx dropped: No pending requests for ${host}`);
                }
            });

            sock.bind(this.bindPort, () => {
                this.socket = sock;
                this.socket.unref(); // don't block node from exiting
                this.currentError = null;
                this.log(`KAB global socket bound to port ${this.bindPort}`);
                resolve();
            });
        });

        await this.bindingData;
        return this.socket!;
    }

    public async sendAndReceive(buf: Buffer, host: string, port: number, timeoutMs: number): Promise<Buffer> {
        const sock = await this.getSocket();
        return new Promise((resolve, reject) => {
            const bufHex = buf.toString('hex');
            const groupKey = `${host}:${port}:${bufHex}`;

            const req: PendingRequest = { resolve, reject };

            // If a group for this identical buf is already pending, piggyback.
            const existing = this.pendingGroups.get(groupKey);
            if (existing) {
                existing.reqs.push(req);
                return;
            }

            // Create a new group and enqueue it for this host.
            const timer = setTimeout(() => {
                // timeout: reject all in group and cleanup
                const grp = this.pendingGroups.get(groupKey);
                if (grp) {
                    for (const r of grp.reqs) {
                        r.reject(new Error(`KAB command timeout after ${timeoutMs}ms for ${host}:${port}`));
                    }
                    this.pendingGroups.delete(groupKey);
                }
                const q = this.pendingQueue.get(host);
                if (q) {
                    const idx = q.indexOf(groupKey);
                    if (idx !== -1) q.splice(idx, 1);
                }
            }, timeoutMs);

            this.pendingGroups.set(groupKey, { reqs: [req], timer });
            if (!this.pendingQueue.has(host)) this.pendingQueue.set(host, []);
            this.pendingQueue.get(host)!.push(groupKey);

            this.log(`KAB tx ${buf.length}B to ${host}:${port}: ${bufHex}`);
            sock.send(buf, 0, buf.length, port, host, (err) => {
                if (err) {
                    const grp = this.pendingGroups.get(groupKey);
                    if (grp) {
                        clearTimeout(grp.timer);
                        for (const r of grp.reqs) r.reject(err);
                        this.pendingGroups.delete(groupKey);
                    }
                    const q = this.pendingQueue.get(host);
                    if (q) {
                        const idx = q.indexOf(groupKey);
                        if (idx !== -1) q.splice(idx, 1);
                    }
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
