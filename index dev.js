const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const mime = require('mime-types');
const qrcode = require('qrcode');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const FileType = require('file-type');
const axios = require('axios');
const rimraf = require('rimraf'); // Tambahkan modul untuk menghapus folder cache


// URL endpoint Apps Script Anda
const GOOGLE_APPS_SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbxvfRB9OtPNwLjKObd6oJXBuZ6K4RmOihRvdvPtHdQ_omu6lOhqAkFHaEFKAVXx4LhI/exec';

const app = express();
const PORT = 3000;

// Fungsi untuk mencatat log ke Google Spreadsheet
async function logToSpreadsheet(name, phoneNumber, status) {
    try {
        const response = await axios.post(GOOGLE_APPS_SCRIPT_URL, {
            name,
            phoneNumber,
            status,
        });
        console.log(`Log berhasil disimpan: ${response.data}`);
    } catch (error) {
        console.error('Gagal mencatat log ke spreadsheet:', error.message);
    }
}

// Konfigurasi Multer untuk upload file
const upload = multer({
    dest: './public/uploads/',
    limits: { fileSize: 10 * 1024 * 1024 },
});

let qrCodeString = '';


let client = null;

app.use(express.static('./public'));

client.on('qr', (qr) => {
    console.log('QR Code tersedia.');
    qrcode.toDataURL(qr, (err, url) => {
        if (err) {
            console.error('Gagal mengonversi QR Code:', err);
            return;
        }
        qrCodeString = url;
    });
});

app.get('/get-qr', (req, res) => {
    if (!qrCodeString) {
        return res.status(200).json({ qr: null, message: 'QR Code belum tersedia.' });
    }
    res.status(200).json({ qr: qrCodeString, message: 'QR Code berhasil diambil.' });
});

client.on('ready', () => {
    console.log('Bot WhatsApp siap digunakan!');
    qrCodeString = '';
});

app.get('/status', (req, res) => {
    const isReady = qrCodeString === '' && client.info;
    res.json({ ready: isReady, message: isReady ? 'Bot WhatsApp siap digunakan!' : 'Menunggu QR Code...' });
});

// Endpoint untuk menghapus sesi (memulai ulang dengan QR Code baru)
app.post('/reset-session', async (req, res) => {
    try {
        rimraf.sync('./session_data'); // Hapus folder sesi
        console.log('Sesi WhatsApp dihapus. Memulai ulang...');
        await client.destroy(); // Tunggu hingga client dihentikan
        initializeClient(); // Inisialisasi ulang client
        res.json({ message: 'Sesi berhasil direset. QR Code baru akan dihasilkan.' });
    } catch (err) {
        console.error('Gagal menghapus sesi:', err);
        res.status(500).json({ message: 'Gagal menghapus sesi.' });
    }
});

// Fungsi untuk inisialisasi ulang client
function initializeClient() {
    client = new Client({
        authStrategy: new LocalAuth({ dataPath: './session_data' }),
    });

    client.on('qr', (qr) => {
        console.log('QR Code tersedia.');
        qrcode.toDataURL(qr, (err, url) => {
            if (err) {
                console.error('Gagal mengonversi QR Code:', err);
                return;
            }
            qrCodeString = url; // Simpan QR Code sebagai data URL
        });
    });

    client.on('ready', () => {
        console.log('Bot WhatsApp siap digunakan!');
        qrCodeString = ''; // Reset QR Code setelah bot siap
    });

    client.initialize();
}

// Inisialisasi pertama kali
initializeClient();


// Fungsi: Konversi nomor format '0' ke '62'
function convertPhoneNumber(phoneNumber) {
    phoneNumber = phoneNumber.replace(/[-\s]/g, ''); // Hapus spasi dan tanda baca
    if (phoneNumber.startsWith('0')) {
        return `62${phoneNumber.slice(1)}`;
    }
    if (phoneNumber.startsWith('+')) {
        return phoneNumber.slice(1);
    }
    return phoneNumber;
}

// Fungsi: Kirim pesan broadcast
async function sendBroadcastMessages(contacts, message, mediaPath) {
    let media = null;

    if (mediaPath) {
        const fileBuffer = fs.readFileSync(mediaPath);
        const fileType = await FileType.fromBuffer(fileBuffer);

        if (!fileType || !['image/jpeg', 'image/png'].includes(fileType.mime)) {
            console.error('File media bukan gambar valid (hanya JPG/PNG).');
            return;
        }

        const fileName = path.basename(mediaPath);
        media = new MessageMedia(fileType.mime, fileBuffer.toString('base64'), fileName);
    }

    for (const { name, number } of contacts) {
        const formattedNumber = `${convertPhoneNumber(number)}@c.us`;

        console.log(`Mengirim pesan ke: ${formattedNumber}`);
        try {
            if (media) {
                await client.sendMessage(formattedNumber, media, { caption: message });
            } else {
                await client.sendMessage(formattedNumber, message);
            }

            console.log(`Pesan berhasil terkirim ke ${number}`);
            await logToSpreadsheet(name, number, 'Berhasil');
        } catch (err) {
            console.error(`Gagal mengirim pesan ke ${number}:`, err);
            await logToSpreadsheet(name, number, 'Gagal');
        }

        await new Promise((resolve) => setTimeout(resolve, 15000));
    }
}

app.post('/upload', upload.fields([{ name: 'numbers' }, { name: 'media' }]), async (req, res) => {
    const numbersFile = req.files['numbers'] ? req.files['numbers'][0].path : null;
    const mediaFile = req.files['media'] ? req.files['media'][0].path : null;
    const message = req.body.message || 'Pesan default';

    if (!numbersFile) {
        return res.status(400).json({ message: 'File nomor wajib diunggah.' });
    }

    try {
        const contacts = fs.readFileSync(numbersFile, 'utf8')
            .split('\n')
            .map((line) => {
                const [name, number] = line.split(',').map((item) => item.trim());
                if (name && number) {
                    return { name, number };
                }
                return null;
            })
            .filter((entry) => entry);

        if (!contacts.length) {
            return res.status(400).json({ message: 'File nomor tidak mengandung data valid.' });
        }

        console.log('Kontak yang akan dikirim:', contacts);

        await sendBroadcastMessages(contacts, message, mediaFile);

        res.json({ message: 'Pesan berhasil diproses!' });
    } catch (err) {
        console.error(err);
        res.status(500).json({ message: 'Terjadi kesalahan saat memproses pengiriman.' });
    }
});

app.listen(PORT, () => {
    console.log(`Server berjalan di http://localhost:${PORT}`);
});
