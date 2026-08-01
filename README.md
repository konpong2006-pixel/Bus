# ระบบจองตั๋วรถร่วมวิศวกรเสนา LINE Bot

เอกสารนี้ทำไว้สำหรับส่งต่องานให้ Codex/ChatGPT บัญชีอื่น หรือคนอื่นมาดูแลต่อได้เร็ว หากต้องเปลี่ยนอีเมล Codex, เครื่อง, หรือ thread เดิม token หมด

## ภาพรวมระบบ

ระบบนี้เป็น LINE OA bot สำหรับ:

- เช็กรอบรถจากข้อมูลใน Google Sheet
- ให้ลูกค้าเลือกวิธีจองก่อน: `จองอัตโนมัติ` หรือ `จองกับแอดมิน`
- จองอัตโนมัติแบบเป็นขั้นตอน: วันที่ → จุดขึ้น → จุดลง → รอบรถ → จำนวนที่นั่ง → ชื่อ/เบอร์ → โอนเงิน/ส่งสลิป → ออกตั๋ว
- ส่งต่อแอดมินเมื่อกด `จองกับแอดมิน` และบอทจะหยุดตอบเพื่อไม่แย่งแอดมิน
- ปิดรับจองอัตโนมัติหลัง 22.00 น. โดยตอบแจ้งปิดรับจองแค่ครั้งเดียว
- มี whitelist สำหรับ LINE test user ให้ทดสอบหลัง 22.00 น. ได้
- มีสวิตช์ `BOT_ENABLED=true/false` สำหรับเปิด/ปิด bot จาก Render

## โครงสร้างไฟล์สำคัญ

```text
src/server.js          ตัวหลักของ LINE webhook และ flow จองตั๋ว
src/data.js            โหลดเส้นทาง/รอบรถ/ราคา จาก Google Sheet หรือไฟล์ local
src/googleSheets.js    เชื่อม Apps Script / Google Sheet
src/slipok.js          ตรวจสลิปผ่าน SlipOK
src/time.js            เวลาไทย / วันไทย
apps-script/Code.gs    โค้ด Apps Script สำหรับอ่าน/เขียน Google Sheet และเก็บสลิปลง Drive
public/payment-qr.png  รูป QR โอนเงินที่บอทส่งให้ลูกค้า
data/*.json            ข้อมูล fallback/local สำหรับเทสต์
test/bot.test.js       test หลัก
.env.example           ตัวอย่าง Environment Variables
```

## Repository และ Deploy

GitHub repo:

```text
https://github.com/konpong2006-pixel/Bus.git
```

Render ตัวหลัก:

```text
https://bus-wbhr.onrender.com
https://bus-wbhr.onrender.com/webhook
https://bus-wbhr.onrender.com/health
```

คำสั่งที่ใช้ประจำ:

```bash
npm install
npm.cmd test
npm start
git status --short
git add src/server.js
git commit -m "ข้อความ commit"
git push
```

บน PowerShell เครื่องนี้ให้ใช้ `npm.cmd test` แทน `npm test` เพราะ execution policy อาจบล็อก npm script

## Environment Variables ใน Render

ตัวหลักและตัวทดสอบใช้ repo เดียวกัน แต่แยก Render service และแยก LINE token/secret

### ค่าพื้นฐาน

```text
BOT_ENABLED=true
LINE_CHANNEL_ACCESS_TOKEN=ใส่ token จาก LINE Developers
LINE_CHANNEL_SECRET=ใส่ secret จาก LINE Developers
PUBLIC_BASE_URL=https://ชื่อ-render-service.onrender.com
PORT=10000
```

หมายเหตุ:

- `BOT_ENABLED=true` เปิดบอท
- `BOT_ENABLED=false` ปิดบอท ไม่ตอบลูกค้า ไม่ตรวจสลิป ไม่แจ้งแอดมิน แต่ webhook ยังรับ LINE ได้ปกติ
- หลังแก้ Environment ใน Render ให้กด `Save, rebuild, and deploy`

### Google Sheet / Apps Script

```text
APPS_SCRIPT_URL=https://script.google.com/macros/s/AKfycbwup5WUpJK6u4L6XT0-XgNGycwC5UtvQR06ZKxj6XwD2f0pMvFvla2HC9Vpz5xftFGQRw/exec
BACKEND_SHEET_ID=1TUzBqCb2muazvHsSN-jYzSOhI_a1Cp7fWauphluo7Zo
BOOKING_SHEET_ID=12lh0jNthN7X5_-mmO1RG1bTdWe4JkskIsP9Av4q2fDA
BOOKING_SHEET_TAB=รายการจอง
```

ชีทหลังบ้านรอบรถ:

```text
1TUzBqCb2muazvHsSN-jYzSOhI_a1Cp7fWauphluo7Zo
```

ชีทระบบจอง:

```text
12lh0jNthN7X5_-mmO1RG1bTdWe4JkskIsP9Av4q2fDA
```

### SlipOK / Slip simulation

```text
SLIPOK_BRANCH_ID=ใส่ branch id
SLIPOK_API_KEY=ใส่ API key จาก SlipOK
SIMULATE_SLIP_OK=false
SAVE_SLIP_TO_DRIVE=false
```

สำหรับตัวทดสอบแนะนำ:

```text
SIMULATE_SLIP_OK=true
SAVE_SLIP_TO_DRIVE=false
```

เมื่อ `SIMULATE_SLIP_OK=true` ลูกค้าส่งรูปอะไรก็จำลองว่าสลิปผ่าน ไม่กินโควต้า SlipOK

### Admin / Test user

```text
ADMIN_LINE_TARGET_ID=ใส่ groupId หรือ userId แอดมิน
LINE_TEST_USER_IDS=ใส่ userId คนทดสอบ
LINE_TEST_GROUP_IDS=ใส่ groupId กลุ่มทดสอบ
```

ถ้ามีหลาย test user หรือหลายกลุ่ม ให้คั่นด้วย comma:

```text
LINE_TEST_USER_IDS=Uxxxx,Uyyyy
LINE_TEST_GROUP_IDS=Cxxxx,Cyyyy
```

`LINE_TEST_USER_IDS` ใช้เพิ่ม tester เป็นรายคน

`LINE_TEST_GROUP_IDS` ใช้ให้ทั้งกลุ่มเป็นกลุ่มทดสอบ ถ้าไม่ได้ตั้งค่านี้ ระบบจะใช้ `ADMIN_LINE_TARGET_ID` เป็นกลุ่มทดสอบให้อัตโนมัติเมื่อค่านั้นเป็น groupId

tester จะคุยกับบอทได้หลัง 22.00 น. แม้ลูกค้าปกติถูกปิดรับจองแล้ว

## LINE OA Setup

ใน LINE Developers:

1. เข้า Messaging API channel ของ OA ที่ต้องการ
2. ตั้ง Webhook URL:

```text
https://ชื่อ-render-service.onrender.com/webhook
```

3. เปิด `Use webhook`
4. กด `Verify` ต้องขึ้น `Success`
5. คัดลอก `Channel secret` และ `Channel access token (long-lived)` ไปใส่ Render

ใน LINE Official Account Manager:

- ปิด `Auto-reply messages` ถ้าไม่ต้องการให้ชนกับ bot
- เปิดให้รับข้อความตามปกติ
- ถ้าจะเชิญ bot เข้ากลุ่ม ต้องเปิด permission ให้เข้าร่วมกลุ่ม/แชทหลายคน

คำสั่งหา id:

- พิมพ์ `ขอไอดีแอดมิน` ในแชทส่วนตัวกับบอท จะได้ userId
- พิมพ์ `ขอไอดีกลุ่ม` ในกลุ่ม LINE ที่มีบอท จะได้ groupId

คำสั่งสำหรับ Tester เท่านั้น:

บัญชีที่จะใช้คำสั่งนี้ได้ต้องอยู่ใน `LINE_TEST_USER_IDS` หรือพิมพ์จากกลุ่มที่อยู่ใน `LINE_TEST_GROUP_IDS`

- `คำสั่งเทส` ดูคำสั่งทั้งหมด
- `สถานะเทส` ดูสถานะบอทและสถานะแชทนี้
- `รีเซ็ตเทส` ล้างสถานะแชท แล้วเริ่มใหม่
- `เริ่มเทส` เปิดข้อความต้อนรับใหม่
- `กลับบอท` ให้บอทกลับมาตอบ หลังจากส่งต่อแอดมิน
- `ขอไอดีกลุ่ม` ดู groupId ในกลุ่ม
- `ขอไอดีแอดมิน` ดู userId ของแชทนี้

## Flow การทำงานของลูกค้า

เมื่อเริ่มคุย บอทถามก่อน:

```text
ต้องการจองแบบไหนคะ 🎫

🤖 จองตั๋วอัตโนมัติ
ระบบจะพาเลือกวันที่ จุดขึ้น จุดลง รอบรถ และชำระเงินในแชทนี้ค่ะ

👤 จองกับแอดมิน
แอดมินจะเข้ามาดูแลและตอบในแชทนี้ค่ะ
```

ถ้าเลือก `จองอัตโนมัติ`:

1. เลือกวันที่
2. เลือกจุดขึ้น
3. เลือกจุดลง
4. เลือกรอบรถ
5. กดจอง
6. แจ้งจุดขึ้นพิเศษ
7. แจ้งจำนวนที่นั่ง
8. แจ้งชื่อ/เบอร์โทร
9. บอทสรุปยอดและส่ง QR
10. ลูกค้าส่งสลิป
11. ระบบตรวจสลิป/จำลองตรวจสลิป
12. ระบบออกตั๋วและแจ้งแอดมิน

ถ้าเลือก `จองกับแอดมิน`:

- บอทตอบข้อความติดต่อแอดมินครั้งเดียว
- ตั้งสถานะ handoff
- หลังจากนั้นบอทไม่ตอบข้อความ/รูปจากลูกค้าอีก เพื่อให้แอดมินตอบเอง
- ถ้าลูกค้าต้องการให้บอทกลับมา ให้พิมพ์ `เริ่มใหม่`, `จองตั๋ว`, หรือ `เช็กรอบรถ`

## กฎเวลา

เวลาทำงานอัตโนมัติ:

```text
07.00-22.00 น.
```

หลัง 22.00 น.:

- ลูกค้าปกติจะได้ข้อความปิดรับจอง 1 ครั้ง
- หลังจากนั้นบอทจะไม่ตอบซ้ำ
- `LINE_TEST_USER_IDS` และ `LINE_TEST_GROUP_IDS` ยังใช้บอทได้ตลอด 24 ชม.

ข้อความปิดรับจอง:

```text
ขณะนี้ปิดรับการจองอัตโนมัติแล้วค่ะ 🙏

ระบบรับจองอัตโนมัติได้ตั้งแต่เวลา 07.00-22.00 น. ของทุกวัน
กรุณาเริ่มจองใหม่พรุ่งนี้ตอนเช้าค่ะ

หากเป็นเรื่องเร่งด่วน สามารถโทร 092-774-4341 ได้ค่ะ
```

## Google Sheet ที่ใช้

### Sheet หลังบ้านรอบรถ

แท็บหลัก:

- `รอบรถ`
- `เปิดปิดรายวัน`
- `รายการเส้นทาง`
- `ราคา ระยอง-โคราช`
- `ราคา โคราช-ระยอง`
- `ราคา โคราช-ชลบุรี`
- `ราคา ชลบุรี-โคราช`
- `เบอร์รถ`
- `คู่มือการกรอก`

แท็บ `รอบรถ` ใช้ columns สำคัญ:

```text
วันที่
เส้นทาง
เวลาออกจากต้นทาง
สถานะรอบ
จำนวนที่นั่ง
หมายเหตุ
เลขรถ/เบอร์รถ
เบอร์โทรคนขับ
```

ระบบแสดงเฉพาะรอบที่ `สถานะรอบ` เป็น `ออกแน่นอน`

วันที่ในชีท:

- ใส่วันที่จริง เช่น `2026-08-02`
- ใส่ `ทุกวัน` สำหรับรอบประจำ

### Sheet รายการจอง

ระบบเขียนข้อมูลเมื่อชำระเงิน/ตรวจสลิปผ่าน:

- วันที่สร้างรายการ
- วันที่เดินทาง
- เส้นทาง
- รอบรถ
- จุดขึ้น
- จุดลง
- จำนวนผู้เดินทาง
- ราคา/ที่นั่ง
- ยอดรวม
- ชื่อผู้จอง
- เบอร์โทร
- จุดขึ้นพิเศษ
- สถานะการจอง
- ลิงก์สลิป
- หมายเหตุ

ถ้าเปิด `SAVE_SLIP_TO_DRIVE=true` และ Apps Script รองรับ ระบบจะพยายามเก็บสลิปลง Drive และใส่ลิงก์ในชีท

## Apps Script

ไฟล์ local:

```text
apps-script/Code.gs
```

หากแก้ Apps Script:

1. เปิด Google Apps Script เดิม
2. เอาโค้ดจาก `apps-script/Code.gs` ไปวางแทน
3. กด `Deploy > Manage deployments`
4. กดรูปดินสอ
5. เลือก `New version`
6. กด `Deploy`
7. ถ้าถามสิทธิ์ ให้กดอนุญาต
8. URL ต้องตรงกับ `APPS_SCRIPT_URL` ใน Render

## ตัวหลักกับตัวทดสอบ

แนะนำให้มี 2 Render services:

### ตัวหลัก

ใช้ LINE OA จริง

```text
BOT_ENABLED=false   # ถ้าต้องการปิดชั่วคราว
BOT_ENABLED=true    # ถ้าต้องการเปิดใช้งานจริง
SIMULATE_SLIP_OK=false
```

### ตัวทดสอบ

ใช้ LINE OA ทดสอบเก่า

```text
BOT_ENABLED=true
SIMULATE_SLIP_OK=true
SAVE_SLIP_TO_DRIVE=false
```

ตัวทดสอบควรใช้ `LINE_CHANNEL_ACCESS_TOKEN` และ `LINE_CHANNEL_SECRET` ของ OA ทดสอบ ไม่ใช่ของตัวจริง

## วิธีให้ Codex อีกบัญชีรับงานต่อ

ถ้าเปลี่ยนอีเมล Codex:

1. เปิดโฟลเดอร์โปรเจกต์:

```text
D:\Dowload\line-bus-bot\line-bus-bot
```

2. ให้ Codex อ่านไฟล์นี้ก่อน:

```text
README.md
```

3. เช็กสถานะ:

```bash
git status --short
git log -5 --oneline
npm.cmd test
```

4. ถ้าจะ deploy:

```bash
git add .
git commit -m "..."
git push
```

5. ถ้าจะคุม Edge/Render ผ่าน Codex:

- เปิด `Settings > Computer use`
- เปิด `Any App`
- เปิด Edge และล็อกอิน Render/LINE/Google ไว้
- อย่าขยับเมาส์ระหว่างที่ Codex กำลังคุมหน้าเว็บ

## สิ่งที่ต้องระวัง

- ห้าม commit token/secret จริงลง Git
- อย่าสลับ `LINE_CHANNEL_SECRET`/`TOKEN` ของตัวจริงกับตัวทดสอบผิด Render
- เปลี่ยน Environment ใน Render แล้วต้องกด `Save, rebuild, and deploy`
- ถ้า LINE webhook verify ขึ้น 500 ให้ดู Render logs ก่อน สาเหตุบ่อยคือ `LINE_CHANNEL_SECRET` ไม่ตรง
- ถ้าบอทไม่ตอบ ให้เช็ก `BOT_ENABLED`
- ถ้าเลย 22.00 น. ลูกค้าปกติจะไม่ตอบซ้ำโดยตั้งใจ
- ถ้าต้องการเทสต์หลัง 22.00 น. ให้ใส่ userId ใน `LINE_TEST_USER_IDS` หรือ groupId ใน `LINE_TEST_GROUP_IDS`

## Health check

เช็ก Render:

```text
https://bus-wbhr.onrender.com/health
```

ควรได้:

```json
{"ok":true}
```

## สถานะปัจจุบันโดยย่อ

- ระบบใช้ Google Sheet เป็น backend หลัก
- ระบบจองอัตโนมัติทำงานเป็น step-by-step
- มีโหมดส่งต่อแอดมิน
- มีโหมดปิด bot จาก Render
- มี LINE test whitelist หลัง 22.00 น.
- มี simulation slip สำหรับตัวทดสอบ
- โค้ดล่าสุดควรผ่าน `npm.cmd test`
