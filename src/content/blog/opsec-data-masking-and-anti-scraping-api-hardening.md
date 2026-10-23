---
title: "Bảo Mật OPSEC & Chống Cào Dữ Liệu (Anti-Scraping): Ẩn Quy Mô User Pool Bằng DTO Projection, Khoá Dozzle Log Streaming & Trói PostgreSQL Vào 127.0.0.1"
description: "Phân tích rủi ro lộ bí mật kinh doanh qua bài toán German Tank Problem, kỹ thuật DTO Projection che giấu dữ liệu trên NestJS, bảo vệ log Dozzle và trói chặt PostgreSQL sau tường lửa DOCKER-USER."
pubDate: 2026-10-23
category: "Security, OPSEC & Infrastructure Hardening"
cover: "https://cdn.khanhdp.com/chronicles/tap-29.webp"
coverAlt: "Bảo mật OPSEC, chống cào dữ liệu và trói chặt PostgreSQL vào localhost"
readingTime: "13 phút đọc"
author: "Dương Phúc Khánh"
featured: false
tags: ["Security", "OPSEC", "Anti-Scraping", "Docker", "PostgreSQL", "NestJS", "Firewall", "iptables"]
relatedEpisodes:
  - ep: 29
    title: "Xoá ngay con số tổng User Pool"
    slug: "tap-29-lo-bi-mat-quan-su-user-pool"
  - ep: 67
    title: "Khoá cửa Dozzle bảo vệ trái tim hạ tầng"
    slug: "tap-67-khoa-cua-dozzle-bao-ve-ha-tang"
  - ep: 117
    title: "Hạ gục bão Port Scanner lúc nửa đêm & trói chặt Postgres vào 127.0.0.1"
    slug: "tap-117-ha-guc-bao-port-scanner-va-service-worker-navigation-preload"
---

Trong thế giới phát triển sản phẩm công nghệ, các lập trình viên thường chỉ chú trọng đến việc "tính năng có chạy được không" mà bỏ quên một khía cạnh sống còn của an toàn thông tin: **OPSEC (Operations Security - An Ninh Tác Chiến)**. Bạn có thể xây dựng một hệ sinh thái microservices tinh vi, mã hóa mật khẩu bằng bcrypt 12 rounds và bật HTTPS nghiêm ngặt, nhưng đối thủ cạnh tranh hoặc những kẻ tấn công trên mạng vẫn có thể "đọc vị" toàn bộ tình hình kinh doanh của bạn chỉ thông qua một vài thông số tưởng chừng vô hại trên API công khai.

Một con số `totalUsers: 14520` trả về trong payload phân trang của bảng xếp hạng, một trường định danh người dùng tự tăng dạng số nguyên (`userId: 8942`), hay một dashboard xem log thời gian thực mở toang không cài mật khẩu đều có thể trở thành vũ khí để đối thủ theo dõi tốc độ tăng trưởng, tỷ lệ rời bỏ (churn rate) và cơ cấu doanh thu của bạn theo từng ngày.

Nghiêm trọng hơn nữa ở tầng hạ tầng, nhiều kỹ sư tin rằng việc bật tường lửa UFW (`ufw enable`) trên máy chủ Linux là đủ để bảo vệ các cổng cơ sở dữ liệu. Nhưng họ không hề biết rằng cơ chế can thiệp bảng `iptables` mặc định của Docker Daemon sẽ **vượt mặt hoàn toàn mọi quy tắc UFW**, khiến cổng PostgreSQL mở toang ra toàn cầu để hàng ngàn bot scanner từ các dải IP lạ thi nhau dò quét mật khẩu suốt đêm.

Bài viết này đi sâu vào giải pháp gia cố OPSEC toàn diện từ tầng ứng dụng đến hạ tầng: triệt tiêu bài toán German Tank Problem bằng **DTO Projection**, đóng khóa công cụ stream log và trói chặt các dịch vụ lưu trữ vào `127.0.0.1` kết hợp chuỗi lọc `DOCKER-USER`.

---

### Bảng So Sánh Kiến Trúc Bảo Mật OPSEC & Hạ Tầng

| Tiêu chí | 1. Sơ khởi (Exposed Everything) | 2. Điểm nghẽn khi Scale (Scraping & Port Scanning) | 3. Chuẩn Big Tech (OPSEC Hardened) |
| :--- | :--- | :--- | :--- |
| **Phơi Lộ Định Danh** | Khóa chính tự tăng dạng số nguyên (`id: 1, 2, 3...`) | Đối thủ cào dữ liệu toàn bộ cơ sở dữ liệu tuần tự | **UUIDv7 ngẫu nhiên hóa hoặc NanoID không thể đoán trước** |
| **Bảo Vệ Quy Mô Khách Hàng** | Trả về `totalCount`, `totalUsers` trên API công khai | Dính bài toán German Tank Problem, lộ tốc độ tăng trưởng | **Curated Windowed Pagination (`hasMore`, không lộ `total`)** |
| **Lọc Dữ Liệu Nhạy Cảm (PII)** | Trả về toàn bộ Entity từ ORM (`SELECT * FROM users`) | Lộ số điện thoại, email, địa chỉ hash mật khẩu | **NestJS DTO Projection (`@Expose`, `@Exclude` whitelist)** |
| **Bảo Vệ Dashboard Log** | Chạy Dozzle trực tiếp ở cổng 8080 không có mật khẩu | Kẻ gian đọc trọn vẹn log request, lộ token & query SQL | **Bảo vệ xác thực đa tầng (YAML Auth + Caddy + VPN IP Whitelist)** |
| **Mở Cổng Cơ Sở Dữ Liệu** | `ports: ["5432:5432"]` trên docker-compose | Docker bypass UFW, bot scanner tấn công brute-force | **Trói cứng `127.0.0.1:5436:5432` + Chuỗi lọc `DOCKER-USER` iptables** |

---

### 1. Sơ khởi: Lỗ Hổng OPSEC Vô Hình & Sự Lơ Là Của Junior Dev

Khi xây dựng các tính năng phân trang cho danh sách người dùng hay bảng xếp hạng, lập trình viên thường viết câu lệnh truy vấn trả về cả dữ liệu lẫn siêu dữ liệu phân trang:

```typescript
// ❌ Sơ khởi: Vô tình làm lộ toàn bộ quy mô quân sự (User Pool)
@Get('leaderboard')
async getLeaderboard(@Query('page') page: number) {
  const [items, totalUsers] = await this.userRepo.findAndCount({
    skip: (page - 1) * 20,
    take: 20,
    order: { score: 'DESC' },
  });

  return {
    items,      // Chứa nguyên vẹn Entity người dùng (kể cả email, phone, created_at)
    totalUsers, // "Bí mật tác chiến" bị phơi bày ra toàn bộ thế giới!
    page,
  };
}
```

Ở tầng hạ tầng, để tiện cho việc kiểm tra log từ xa và kết nối công cụ GUI như DBeaver vào cơ sở dữ liệu, file `docker-compose.yml` thường được viết như sau:

```yaml
# ❌ Sơ khởi: Mở toang cổng ra toàn bộ Internet công cộng
services:
  postgres:
    image: postgres:17-alpine
    ports:
      - "5432:5432" # Lắng nghe trên 0.0.0.0 (Mở cổng ra toàn cầu!)
    environment:
      POSTGRES_PASSWORD: supersecretpassword

  dozzle:
    image: amir20/dozzle:latest
    ports:
      - "8080:8080" # Bất kỳ ai biết IP máy chủ đều xem được live log!
```

---

### 2. Điểm nghẽn khi Scale: German Tank Problem & Cơn Bão Port Scanner

#### A. Bài toán xe tăng Đức (The German Tank Problem) trong kinh doanh
Trong Thế chiến thứ Hai, phe Đồng Minh đã ước tính chính xác số lượng xe tăng do Đức sản xuất mỗi tháng chỉ bằng cách thống kê các số sê-ri tuần tự thu thập được từ bánh răng của những chiếc xe tăng bị bắn hạ. 

Nếu ứng dụng của bạn trả về `userId: 12540` vào ngày 1 tháng 10, và trả về `userId: 13200` vào ngày 8 tháng 10, đối thủ chỉ cần làm phép tính trừ đơn giản là biết chính xác tuần đó bạn có **660 người dùng mới đăng ký**. Họ lập biểu đồ theo dõi từng ngày, biết được chiến dịch marketing nào của bạn hiệu quả, thời điểm nào bạn kiệt quệ tài chính để tung đòn hạ gục. Tương tự, con số `totalUsers: 14520` là một chỉ số tình báo vô giá cho phép đối thủ biết toàn bộ quy mô thật của bạn mà không tốn một đồng chi phí điều tra.

#### B. Nguy cơ rò rỉ dữ liệu qua công cụ Log Streaming (Dozzle)
Dozzle là một công cụ xem log Docker tuyệt vời và trực quan. Nhưng khi một junior dev để Dozzle mở ở cổng mặc định:
- Bất kỳ con bot nào quét cổng web cũng có thể truy cập vào giao diện web realtime.
- Nếu backend có ghi log các lỗi ném ra từ cơ sở dữ liệu hoặc ghi lại `req.body` khi debug, toàn bộ Access Token, Refresh Token, mã xác thực OTP hay các chuỗi kết nối nội bộ đều bị truyền trực tiếp tới màn hình của kẻ tấn công thông qua Server-Sent Events (SSE).

#### C. Chiếc bẫy Docker bypass UFW iptables
Đây là cạm bẫy hạ tầng khiến hàng ngàn quản trị viên hệ thống phải trả giá đắt:
- Quản trị viên cài đặt UFW trên máy chủ Ubuntu/Debian:
  ```bash
  sudo ufw default deny incoming
  sudo ufw allow 80/tcp
  sudo ufw allow 443/tcp
  sudo ufw allow 22/tcp
  sudo ufw enable
  ```
- Quản trị viên an tâm nghĩ rằng cổng `5432` của PostgreSQL đã được khóa chặt.
- **Thực tế tàn nhẫn**: Docker Daemon khởi động với cờ `--iptables=true` mặc định. Khi một container có khai báo `ports: ["5432:5432"]`, Docker sẽ tự động chèn các quy tắc `PREROUTING` và `FORWARD` vào bảng `nat` và `filter` của iptables nằm **trước** các chuỗi của UFW!
- Mọi gói tin từ Internet gửi đến cổng 5432 đều được chuyển tiếp thẳng vào container PostgreSQL trước khi UFW kịp nhìn thấy.
- Đến 02:00 sáng, hàng trăm IP từ Nga, Trung Quốc và các máy chủ quét cổng bắt đầu mở kết nối brute-force vào PostgreSQL. Log container đầy ắp hàng ngàn dòng:
  ```text
  FATAL: password authentication failed for user "postgres"
  LOG: could not receive data from client: Connection reset by peer
  ```
  Connection pool của cơ sở dữ liệu bị chiếm dụng, CPU tăng vọt và ứng dụng chính bắt đầu nghẽn kết nối.

---

### 3. Chuẩn Big Tech: DTO Projection, Dozzle Hardening & Khiên DOCKER-USER

#### A. Che Giấu Quy Mô Bằng DTO Projection & Curated Pagination
Không bao giờ trả về nguyên vẹn database entity ra ngoài API công khai. Áp dụng quy tắc phòng thủ sâu của NestJS:
1. **Bật `ClassSerializerInterceptor` toàn cục** với tùy chọn `excludeExtraneousValues: true`. Mọi trường không có `@Expose()` sẽ bị xóa sạch khỏi payload trả về.
2. **Loại bỏ con số tổng**: Thay vì trả về `totalUsers`, sử dụng kỹ thuật kiểm tra trang kế tiếp (`hasMore: items.length > limit`). Nếu cần hiển thị quy mô, chỉ hiển thị số lượng làm tròn mang tính biểu tượng (ví dụ: "10,000+ thành viên").
3. **Mặt nạ hóa dữ liệu nhạy cảm**: Số điện thoại hoặc email nếu cần hiển thị phải qua hàm băm che giấu (`090****123`).

```typescript
// ✅ Chuẩn Big Tech: DTO Projection bảo vệ bí mật kinh doanh và PII
import { Exclude, Expose, Transform } from 'class-transformer';

export class PublicLeaderboardUserDto {
  @Expose()
  uuid: string; // Sử dụng định danh opaque thay vì ID tự tăng

  @Expose()
  name: string;

  @Expose()
  avatarUrl: string;

  @Expose()
  rank: number;

  @Expose()
  score: number;

  // Che giấu số điện thoại cá nhân
  @Expose()
  @Transform(({ value }) => {
    if (!value || typeof value !== 'string') return null;
    return value.replace(/(\d{3})\d{4}(\d{3})/, '$1****$2');
  })
  maskedPhone: string;

  // Triệt để loại trừ toàn bộ dữ liệu nội bộ
  @Exclude()
  internalId: number;

  @Exclude()
  email: string;

  @Exclude()
  passwordHash: string;

  @Exclude()
  role: string;
}

// Controller chỉ trả về dữ liệu an toàn kèm cờ hasMore
@Get('leaderboard')
async getLeaderboard(@Query('limit') limit = 20, @Query('cursor') cursor?: string) {
  const users = await this.userService.fetchWindow({ limit: limit + 1, cursor });
  const hasMore = users.length > limit;
  const slicedUsers = hasMore ? users.slice(0, limit) : users;

  return {
    data: plainToInstance(PublicLeaderboardUserDto, slicedUsers, {
      excludeExtraneousValues: true,
    }),
    hasMore,
    nextCursor: hasMore ? slicedUsers[slicedUsers.length - 1].uuid : null,
  };
}
```

#### B. Khóa Cửa Dozzle Bằng Xác Thực Người Dùng (YAML Auth)
Trong cấu hình hạ tầng của Dozzle, chúng ta kích hoạt cơ chế xác thực nội bộ qua file cấu hình `users.yml` được mã hóa mật khẩu, đồng thời loại bỏ việc mở cổng trực tiếp ra Internet mà đưa Dozzle chạy đằng sau mạng riêng ảo Docker (`ops_bridge`) kết hợp Caddy Reverse Proxy:

```yaml
# ✅ Chuẩn Big Tech: Dozzle được khóa chặt sau lớp xác thực
services:
  dozzle:
    image: amir20/dozzle:v8
    container_name: dozzle
    restart: unless-stopped
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
      - /opt/dozzle-data/users.yml:/data/users.yml:ro
    environment:
      DOZZLE_AUTH_PROVIDER: simple
      DOZZLE_KEY: ${DOZZLE_SESSION_SECRET}
    networks:
      - ops_bridge
    # KHÔNG mở cổng ports: ["8080:8080"] ra host!
    # Truy cập thông qua Caddy Reverse Proxy có SSL và Cloudflare bảo vệ
```

Nội dung file cấu hình người dùng `/opt/dozzle-data/users.yml`:
```yaml
# Danh sách tài khoản quản trị được mã hóa bcrypt
users:
  - username: admin_kido
    password: "$2a$12$e8Zbz6L.ExampleBcryptHashSecureKey..."
    name: "System Administrator"
    email: "admin@khanhdp.com"
```

#### C. Trói Chặt PostgreSQL Vào Localhost & Chuỗi Lọc `DOCKER-USER`
Để bảo vệ cơ sở dữ liệu khỏi các cuộc tấn công quét cổng:
1. **Luôn ràng buộc IP máy chủ rõ ràng**: Thay vì `5432:5432`, bắt buộc phải viết `"127.0.0.1:5436:5432"`. Lúc này, cổng chỉ mở cho các tiến trình nội bộ trên chính máy chủ VPS kết nối qua SSH Tunnel, toàn bộ Internet bên ngoài không thể chạm tới.
2. **Thiết lập chuỗi tường lửa `DOCKER-USER`**: Docker cung cấp chuỗi `DOCKER-USER` trong iptables để quản trị viên có thể chèn quy tắc lọc trước khi gói tin đi vào container.

Tập lệnh shell `/usr/local/bin/docker-user-firewall.sh` được cấu hình chạy tự động lúc khởi động hệ thống qua systemd:

```bash
#!/usr/bin/env bash
# ✅ Chuẩn Big Tech: docker-user-firewall.sh bảo vệ các cổng Docker
set -euo pipefail

echo "==> Đang áp dụng khiên DOCKER-USER cho hệ thống..."

# 1. Xóa sạch các quy tắc cũ trong chuỗi DOCKER-USER
iptables -F DOCKER-USER 2>/dev/null || true

# 2. Cho phép các kết nối đã thiết lập từ trước (ESTABLISHED, RELATED)
iptables -A DOCKER-USER -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN

# 3. Cho phép toàn bộ lưu lượng nội bộ Loopback và Docker Bridge nội bộ
iptables -A DOCKER-USER -i lo -j RETURN
iptables -A DOCKER-USER -s 127.0.0.1 -j RETURN
iptables -A DOCKER-USER -s 172.16.0.0/12 -j RETURN

# 4. Giới hạn cổng DNS AdGuard Home (cổng 53) chỉ cho phép các IP tin cậy
# Ngăn chặn các cuộc tấn công DNS Amplification DDoS từ bên ngoài
iptables -A DOCKER-USER -p udp --dport 53 -s 118.68.0.0/16 -j RETURN
iptables -A DOCKER-USER -p tcp --dport 53 -s 118.68.0.0/16 -j RETURN
iptables -A DOCKER-USER -p udp --dport 53 -j DROP
iptables -A DOCKER-USER -p tcp --dport 53 -j DROP

# 5. Mặc định tiếp tục cho phép các cổng web công cộng (80, 443) đi vào Caddy
iptables -A DOCKER-USER -j RETURN

echo "==> Hoàn tất cài đặt khiên DOCKER-USER. Đã triệt hạ toàn bộ port scanner!"
```

Cấu hình PostgreSQL trong `docker-compose.yml`:
```yaml
services:
  postgres:
    image: postgres:17-alpine
    container_name: shared_db
    restart: unless-stopped
    ports:
      # TRÓI CHẶT vào localhost 127.0.0.1, tuyệt đối không dùng 0.0.0.0
      - "127.0.0.1:5436:5432"
    environment:
      POSTGRES_USER: ${POSTGRES_USER}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
      POSTGRES_DB: ${POSTGRES_DB}
    networks:
      - ops_bridge
```

---

### Kết Quả Triển Khai Thực Tế

Sau khi áp dụng chiến lược OPSEC đa tầng:
- **Tình báo đối thủ**: Xóa bỏ hoàn toàn nguy cơ rò rỉ tốc độ tăng trưởng người dùng qua bài toán German Tank Problem nhờ DTO Projection và Cursor-based Pagination.
- **Rò rỉ dữ liệu qua Log**: 100% phiên truy cập Dozzle được bảo vệ bằng tài khoản mã hóa mật khẩu, ngắt kết nối trực tiếp khỏi cổng Internet công cộng.
- **Tấn công quét cổng nửa đêm**: Lượng gói tin tấn công brute-force vào PostgreSQL giảm từ **hơn 40.000 requests/đêm về con số 0 tròn trĩnh** nhờ sự kết hợp giữa bind `127.0.0.1` và chuỗi lọc `DOCKER-USER`.
- **Hiệu năng hệ thống**: Tải CPU của database vào ban đêm giảm 15%, connection pool luôn sẵn sàng phục vụ các tác vụ xử lý của người dùng thật.

---

### Liên Kết Ký Sự & Tranh Minh Họa Kido Chronicles

Để theo dõi góc nhìn hài hước, drama thực chiến và tranh minh họa manga về các sự cố này, bạn có thể đón đọc các tập ký sự liên quan tại:
- [Tập 29: Xoá ngay con số tổng User Pool](https://truyen.khanhdp.com/tap/tap-29-lo-bi-mat-quan-su-user-pool/)
- [Tập 67: Khoá cửa Dozzle bảo vệ trái tim hạ tầng](https://truyen.khanhdp.com/tap/tap-67-khoa-cua-dozzle-bao-ve-ha-tang/)
- [Tập 117: Hạ gục bão Port Scanner lúc nửa đêm & trói chặt Postgres vào 127.0.0.1](https://truyen.khanhdp.com/tap/tap-117-ha-guc-bao-port-scanner-va-service-worker-navigation-preload/)
