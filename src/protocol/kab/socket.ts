import * as dgram from 'dgram';
import { KAB_COMMAND_PORT } from '../../settings.js';

interface PendingRequest {
    resolve: (data: Buffer) => void;
    reject: (err: Error) => void;
}

interface PendingGroup {
    reqs: PendingRequest[];
    timer: NodeJS.Timeout;
    /** Optional validation function called for every incoming packet before
     * resolving the group.  If it returns false the message is ignored and the
     * group remains pending. */
    filter?: (msg: Buffer, rinfo: dgram.RemoteInfo) => boolean;
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
     * any commands (e.g. from platform initialization).  If a socket is
     * already bound we tear it down so the next call to getSocket() will bind
     * again to the new port. */
    public setBindPort(port: number) {
        this.bindPort = port;
        if (this.socket) {
            try { this.socket.close(); } catch {}
            this.socket = null;
            this.bindingData = null;
        }
    }

    /**
     * Read‑only accessor for the currently configured bind port.  Used by
     * callers that need to temporarily switch to an ephemeral port then restore
     * the original value.
     */
    public getBindPort(): number {
        return this.bindPort;
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
            // use SO_REUSEADDR and SO_REUSEPORT so multiple processes (e.g. diag,
            // another instance) can listen on the same port simultaneously.  On
            // Linux SO_REUSEPORT gives each socket its own queue but both will
            // receive copies of incoming datagrams.
            const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true, reusePort: true });
            
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
                if (!queue || queue.length === 0) {
                    this.log(`KAB rx dropped: No pending requests for ${host}`);
                    return;
                }

                // walk the queue looking for a group whose filter (if any) accepts
                // this message.  keep the first matching entry in FIFO order.
                for (let idx = 0; idx < queue.length; idx++) {
                    const groupKey = queue[idx];
                    const group = this.pendingGroups.get(groupKey);
                    if (!group) continue;
                    if (group.filter) {
                        if (group.filter === undefined) {
                            // shouldn't happen
                        } else if (!group.filter(msg, rinfo)) {
                            // log reason if filter rejected self-echo
                            if (msg.equals(Buffer.from(groupKey.split(':')[2], 'hex'))) {
                                this.log('KAB rx filtered: self echo');
                            } else {
                                this.log('KAB rx filtered: predicate denied');
                            }
                            continue; // not for this group
                        }
                    }
                    // match: remove the key from queue and resolve
                    queue.splice(idx, 1);
                    clearTimeout(group.timer);
                    for (const req of group.reqs) {
                        req.resolve(msg);
                    }
                    this.pendingGroups.delete(groupKey);
                    return;
                }

                this.log(`KAB rx dropped: no group accepted the packet`);
            });

            sock.bind(this.bindPort, () => {
                this.socket = sock;
                this.socket.unref(); // don't block node from exiting
                this.currentError = null;
                const addr = this.socket.address();
                this.log(`KAB global socket bound to ${addr.address}:${addr.port}`);
                resolve();
            });
        });

        await this.bindingData;
        return this.socket!;
    }

    public async sendAndReceive(
        buf: Buffer,
        host: string,
        port: number,
        timeoutMs: number,
        filter?: (msg: Buffer, rinfo: dgram.RemoteInfo) => boolean,
    ): Promise<Buffer> {
        const sock = await this.getSocket();
        return new Promise((resolve, reject) => {
            const bufHex = buf.toString('hex');
            const groupKey = `${host}:${port}:${bufHex}`;

            const req: PendingRequest = { resolve, reject };

            // If a group for this identical buf is already pending, piggyback (and
            // inherit its filter if one exists).
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

            this.pendingGroups.set(groupKey, { reqs: [req], timer, filter });
            if (!this.pendingQueue.has(host)) this.pendingQueue.set(host, []);
            this.pendingQueue.get(host)!.push(groupKey);

            // attempt to decode cmdCode/subtype/payload for clarity
            let desc = '';
            try {
                if (buf.length >= 84) {
                    const code = buf.readUInt32LE(4);
                    const subtype = buf.readUInt32LE(76);
                    const payload = buf.readUInt32LE(80);
                    if (code === 22 && subtype === 106) {
                        desc = `STATUS_QUERY`; // payload ignored
                    } else if (code === 23 && subtype === 106) {
                        desc = payload === 1 ? 'POWER_ON' : 'POWER_OFF';
                    } else {
                        desc = `cmd=${code} sub=${subtype} p=${payload}`;
                    }
                }
            } catch {}
            this.log(`KAB tx ${buf.length}B to ${host}:${port}${desc ? ' ['+desc+']' : ''}: ${bufHex}`);
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
