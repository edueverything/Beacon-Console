import { hexToBytes, splitIntoPages, STK500 } from './STK500.js'

const decoder = new TextDecoder()
const encoder = new TextEncoder()

export class Beacon {
    /**
     * A utility class for interacting with a Beacon
     * 
     * @param {object} port a SerialPort object (https://developer.mozilla.org/en-US/docs/Web/API/SerialPort)
     * @param {int} id an id which will be displayed as `Beacon ${id}`, no other purpose
     * @param {object} beacon_ids a useRef with a array of beacon ids (useRef)
     * @param {Function} set_beacon_ids function to set beacon_ids (useState)
     * @param {Function} set_global_buffer A method to set the global buffer
     */
    constructor(port, id, beacon_ids, set_beacons, set_global_buffer) {

        this.port = port;
        this.readingFlag = false;
        this.writer = port.writable.getWriter();
        this.reader = port.readable.getReader();
        this.currentBaud = 57600; // the port is opened at sketch speed by App.js
        this.lastUpdateError = null;

        this.internal_buffer = [];

        this.uploading = false;
        this.uploading_buffer = { value: null };

        this.CF_Start_Blue = true;
        this.CF_Is_Blue = true;
        this.Blinking = false;
        this.id = id;

        this.port.addEventListener("disconnect", (event) => {
            console.log("dissconnect")
            //remove from beacons
            set_beacons(prev => prev.filter(b => b.id !== this.id))

            //set this id in beacon ids to null - will be reused
            beacon_ids.current[this.id-1] = null

            //put dissconect msg in buffer
            set_global_buffer(prev => {
                return [...prev, "disconnect"];
            });

        });
    }

    /**
    * Returns true if the Beacon is on the specified firmware version
    * 
    * @param {string} version the version of the Beacon (i.e "0.1.0")
    */
    async checkVersion(version, timeoutMs = 3500) {
        // The Beacon firmware can block for up to about a second in its
        // distance sensor read, so a single ask and a 500 ms wait (the old
        // behavior) often missed the reply and triggered a needless upload.
        // Ask again every 700 ms and keep listening for a few seconds.
        const startTime = performance.now()
        let lastAsked = 0
        while (performance.now() - startTime < timeoutMs) {
            if (performance.now() - lastAsked >= 700) {
                await this.sendCmd("Get_Version")
                lastAsked = performance.now()
            }
            for (const i of this.internal_buffer) {
                if (i.trim() === version) {
                    //remove it
                    this.internal_buffer = this.internal_buffer.filter(item => item !== i)
                    return true
                }
            }
            //yield to main loop
            await new Promise(resolve => setTimeout(resolve, 10))
        }
        return false
    }

    /**
     * Sends the "Blink" command to the beacon, which will cause it to blink
     */
    async blink() {
        await this.sendCmd("Blink")
    }

    /**
    * Checks the current version of the Beacon and updates it to the newest firmware version
    * 
    * @param {string} version The newest firmware version (i.e "0.1.0")
    * @param {Function} set_connecting_stack A useState function to show the update progress
    */
    // Stop the reading loop and release the port streams so the port can
    // be closed, reopened at another baud rate, or handed to the uploader.
    async _releaseStreams() {
        this.readingFlag = false
        // give the reading loop a moment to notice the flag and exit
        await new Promise(resolve => setTimeout(resolve, 100))
        try { await this.reader.cancel() } catch (err) { /* already closed */ }
        try { this.reader.releaseLock() } catch (err) { /* already released */ }
        try { this.writer.releaseLock() } catch (err) { /* already released */ }
    }

    // Open the port at the given baud rate and take fresh streams.
    async _openAt(baudRate) {
        if (this.port.readable || this.port.writable) {
            await this.port.close()
        }
        await this.port.open({ baudRate })
        this.currentBaud = baudRate
        this.writer = this.port.writable.getWriter()
        this.reader = this.port.readable.getReader()
    }

    // Put the port back at sketch speed (57600) with fresh streams, so the
    // Beacon can be talked to normally whether the upload worked or not.
    async _restoreSketchConnection(waitMs) {
        try {
            await this._releaseStreams()
            await this._openAt(57600)
            await new Promise(resolve => setTimeout(resolve, waitMs))
        } catch (err) {
            console.log("could not restore Beacon connection:")
            console.log(err)
        }
    }

    // One upload attempt at one bootloader speed. Throws on failure.
    async _uploadAtSpeed(pages, baudRate) {
        await this._releaseStreams()
        if (this.currentBaud !== baudRate || !this.port.readable) {
            await this._openAt(baudRate)
        } else {
            this.writer = this.port.writable.getWriter()
            this.reader = this.port.readable.getReader()
        }

        const stk = new STK500(this.port, this.writer, this.reader, this.uploading_buffer);

        await stk.resetArduino();          // force it into the bootloader
        await stk.flushInput();            // drop stale sketch output so it cannot desync us
        await stk.sync();                  // make sure it's listening
        await stk.enterProgrammingMode();  // start a programming session

        for (let i = 0; i < pages.length; i++) {
            const address = i * 128;
            await stk.setAddress(address);
            await stk.writePage(new Uint8Array(pages[i]));
        }

        await stk.leaveProgrammingMode(); // Arduino will now run the new sketch
    }

    async update(version, set_connecting_stack) {
        this.lastUpdateError = null
        if (await this.checkVersion(version)) {
            return true
        }

        set_connecting_stack(prev => {
            const copy = [...prev]
            copy.pop()
            copy.push((<p className='text-xl text-gray-600 mt-3.5'>Uploading Firmware {version}</p>))
            return copy
        })

        // Download and validate the firmware BEFORE touching the Beacon,
        // from this site's own copy (this used to point at Jaxson's site
        // and never checked that the download actually worked).
        let pages
        try {
            const firmwareUrl = `${(process.env.PUBLIC_URL || '').replace(/\/$/, '')}/Beacon.hex`
            const response = await fetch(firmwareUrl)
            if (!response.ok) {
                throw new Error(`Firmware download failed (HTTP ${response.status})`)
            }
            const hexFileText = await response.text()
            const bytes = hexToBytes(hexFileText)
            if (!bytes || bytes.length === 0) {
                throw new Error("Firmware file was empty or unreadable")
            }
            pages = splitIntoPages(bytes)
        } catch (err) {
            console.log("firmware download err:")
            console.log(err)
            this.lastUpdateError = err
            return false
        }

        // Older Beacons use the original bootloader at 57600 baud, newer
        // ones use the current bootloader at 115200. Try the sketch speed
        // first (matches the older units that already update fine), then
        // the newer speed, with a fresh reset into the bootloader for each.
        const speeds = [57600, 115200]
        let uploaded = false
        for (const speed of speeds) {
            try {
                await this._uploadAtSpeed(pages, speed)
                uploaded = true
                break
            } catch (err) {
                console.log(`uploading at ${speed} baud err:`)
                console.log(err)
                this.lastUpdateError = err
            }
        }

        // Either way, leave the Beacon connected and talking at sketch
        // speed. A failed update must not kill the connection, which is
        // what the old code did by closing the port on failure.
        await this._restoreSketchConnection(uploaded ? 1500 : 500)

        return uploaded
    }

    /**
    * Begins a reading loop that will update the supplied buffer and an internal buffer as new lines are read
    * 
    * To stop the loop use stopReading()
    * 
    * @param {Function} set_global_buffer A method to set the global buffer
    */
    async startReading(set_global_buffer) {
        this.readingFlag = true
        let buffer = ""
        while (this.readingFlag) {
            const value = await this.read()

            if (value === undefined) {
                console.log("reading cancled")
                return
            }

            buffer += decoder.decode(value)
            if (buffer[buffer.length - 1] === "\n") {
                const line = buffer
                this.internal_buffer.push(line)
                if (line[0] !== "v") {
                    // console.log(line)
                    set_global_buffer(prev => {
                        return [...prev, line];
                    });
                    if (line.trim() === "Blue") {
                        this.CF_Is_Blue = true
                    } else if (line.trim() === "Red") {
                        this.CF_Is_Blue = false
                    }
                }
                buffer = ""
            }

        }
    }

    /**
     * Stops the reading loop started by startReading()
     */
    stopReading() {
        this.readingFlag = false;
    }

    /**
     * Reads via this.reader.read() with error handling
     * 
     * @returns the value recieved from this.reader.read
     */
    async read() {
        try {
            const { value } = await this.reader.read()
            return value
        } catch(err) {
            console.log("reading err:")
            console.log(err)
        }
    }

    /**
     * Sends the supplied command to the Beacon
     * 
     * @param {string} command The command to send to the Beacon, do not include a newline
     */
    async sendCmd(command) {
        try {
            await this.writer.write(encoder.encode(command + "\n"))
        } catch(err) {
            console.log("writing err:")
            console.log(err)
        }
    }
}