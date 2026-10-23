---
title: "Vận Hành 30+ Container Production Trên VPS 8GB RAM: Zero-Downtime Caddy Reverse Proxy, Dual-Network DNS Isolation & Tinh Chỉnh Kernel vm.swappiness = 10"
description: "Nghệ thuật tối ưu hạ tầng chi phí thấp nhưng đạt độ ổn định 99.99%: Cấu hình Caddy reload không gián đoạn, ngăn chặn va chạm DNS Docker và thuật toán kiểm soát bộ nhớ Linux kernel."
pubDate: 2026-10-23
category: "DevOps, Linux Kernel & Infrastructure"
cover: "https://cdn.khanhdp.com/chronicles/tap-22.webp"
coverAlt: "Vận hành 30+ container trên VPS 8GB RAM với Caddy và tối ưu Linux kernel"
readingTime: "11 phút đọc"
author: "Dương Phúc Khánh"
featured: false
tags: ["DevOps", "Docker", "Caddy", "Linux", "Sysctl", "Reverse Proxy", "Infrastructure"]
relatedEpisodes:
  - ep: 2
    title: "Ca mổ sống zero downtime"
    slug: "tap-2-ca-mo-song-zero-downtime"
  - ep: 18
    title: "Mở Dozzle xem log và 6 mảnh đời Docker"
    slug: "tap-18-mo-dozzle-va-6-manh-doi-docker"
  - ep: 19
    title: "Chiến dịch Monorepo"
    slug: "tap-19-chien-dich-monorepo"
  - ep: 20
    title: "Nỗi đau SSH deploy tay"
    slug: "tap-20-noi-dau-ssh-deploy-tay"
  - ep: 21
    title: "Zero downtime rolling update"
    slug: "tap-21-zero-downtime-rolling-update"
  - ep: 22
    title: "Con quái vật OOM Killer"
    slug: "tap-22-con-quai-vat-oom-killer"
  - ep: 38
    title: "Va chạm trên đường băng deploy"
    slug: "tap-38-va-cham-tren-duong-bang-deploy"
  - ep: 106
    title: "Nỗi đau 6 cụm Staging phân mảnh"
    slug: "tap-106-noi-dau-6-cum-staging-phan-manh"
  - ep: 114
    title: "Khai tử Nginx Portfolio & tuyệt kỹ Caddy Native File Server"
    slug: "tap-114-voi-caddy-roi-thi-caddy-het-khai-tu-nginx-portfolio"
---

Nhiều startup thường lãng phí hàng ngàn USD mỗi tháng cho các cụm máy chủ đám mây đắt đỏ (AWS ECS, Kubernetes đa node) ngay từ khi lượng truy cập thực tế mới ở mức vài triệu lượt xem mỗi tháng. Ngược lại, việc ép toàn bộ hệ thống gồm hơn 30 container dịch vụ (Backend APIs, Cơ sở dữ liệu PostgreSQL, Valkey Caches, Nginx, Uptime Monitoring, Observability) chạy trên một máy chủ ảo VPS giá rẻ (4 vCPU, 8GB RAM, NVMe SSD) đòi hỏi một trình độ làm chủ hệ thống ở cấp độ nhân Linux (Kernel).

Nếu không nắm vững nguyên lý hoạt động của Linux Virtual Memory, Docker Embedded DNS và Reverse Proxy, bạn sẽ liên tục bị đánh thức giữa đêm vì tiến trình Out-Of-Memory (OOM) Killer tàn sát ngẫu nhiên các cơ sở dữ liệu quan trọng nhất.

---

### Bảng So Sánh Kiến Trúc Vận Hành Hạ Tầng

| Tiêu chí | 1. Sơ khởi (Naive VPS Setup) | 2. Điểm nghẽn khi Scale | 3. Chuẩn Big Tech (Frugal Engineering) |
| :--- | :--- | :--- | :--- |
| **Reverse Proxy** | Nginx cài tay, mỗi lần đổi phải `systemctl restart` | Rớt kết nối TLS (Downtime 2-5 giây), SSL hết hạn | **Caddy 2 Alpine: Zero-Downtime Dynamic API Reload** |
| **Mạng Docker** | Nhét chung 30 container vào 1 bridge network | Docker DNS round-robin đè dữ liệu Prod/Staging | **Dual-Network Pattern: Private Subnets + Strict Aliases** |
| **Quản lý Swap** | Tắt Swap hoặc để mặc định Linux `swappiness = 60` | Swap thrashing nghẽn 100% I/O ổ cứng NVMe | **NVMe Swap 4GB + `vm.swappiness = 10` + Memory Limit** |
| **Bảo vệ OOM** | Không cấu hình cgroups, để kernel tự xử lý | OOM Killer bắn chết tiến trình PostgreSQL chính | **`oom_score_adj`: Ưu tiên bảo vệ Database tối cao** |
| **Quy trình Deploy** | SSH vào máy chủ gõ `docker compose build` thủ công | Làm cạn kiệt CPU máy chủ khiến khách hàng bị 502 | **Git-Driven Pipelines + Prebuilt Multi-Arch Images** |

---

### 1. Sơ khởi (Naive Approach)

Mô hình phổ biến khi mới thuê VPS:
- Tạo một file `docker-compose.yml` duy nhất chứa tất cả: Web, API, Database, Redis.
- Tên dịch vụ trong mạng được đặt theo các alias thông thường như `db`, `redis`, `api`.
- Nginx cấu hình truyền thống và mỗi khi thêm một subdomain mới, quản trị viên gõ `nginx -s reload` hoặc `systemctl restart nginx`.
- Không thiết lập bất kỳ giới hạn bộ nhớ (`deploy.resources.limits`) nào cho từng container.

---

### 2. Điểm nghẽn khi Scale (Scale Bottlenecks & Failure Modes)

1. **Thảm Họa Đánh Tráo Dữ Liệu Qua Docker Embedded DNS (127.0.0.11)**: Khi bạn dựng thêm một stack Staging (`vantoi-staging`) và vô tình nối nó vào chung mạng `ops_bridge` với cùng alias `db`. Trình phân giải DNS nội bộ của Docker sẽ kích hoạt cơ chế Round-Robin. 50% request từ ứng dụng Production sẽ kết nối nhầm sang database của Staging và ngược lại, gây ra thảm họa làm bẩn dữ liệu không thể phục hồi!
2. **Cơn Ác Mộng Swap Thrashing Với `swappiness = 60`**: Khi lượng RAM sử dụng chạm ngưỡng 80%, với giá trị `swappiness = 60` mặc định của Ubuntu, nhân Linux sẽ tích cực đẩy các trang bộ nhớ của tiến trình PostgreSQL vào ổ đĩa Swap. Vì tốc độ Swap (ngay cả trên NVMe) chậm hơn RAM vật lý hàng trăm lần, I/O Wait vọt lên 100%, toàn bộ máy chủ bị treo cứng (Kernel Panic Freeze).
3. **Phát Súng Tử Thần Của OOM-Killer**: Khi một worker Node.js bị memory leak và ngốn hết số RAM còn lại, Linux Kernel kích hoạt cơ chế OOM Killer. Thay vì giết tiến trình gây leak, thuật toán `badness score` lại chọn tiến trình có dung lượng bộ nhớ lớn nhất và chạy lâu nhất: chính là tiến trình master của **PostgreSQL**!

---

### 3. Chuẩn Big Tech Production (Tier-1 Architecture: Frugal Engineering)

#### A. Caddy 2: Reload Cấu Hình Không Gián Đoạn Kết Nối (Zero-Downtime)
Thay thế toàn bộ Nginx cồng kềnh bằng Caddy 2 chạy trong container siêu nhẹ (`caddy:2-alpine`). Khi cần thêm bớt domain hoặc chuyển hướng route, chúng ta gửi tín hiệu reload thông qua API Unix Socket hoặc lệnh `caddy reload`:

```bash
# ✅ Chuẩn Big Tech: Reload cấu hình trong 12 mili-giây mà không rớt dù chỉ 1 kết nối TCP
ssh contabo "docker exec caddy caddy reload --config /etc/caddy/Caddyfile"
```

Caddy tự động quản lý chứng chỉ SSL TLS Cloudflare Origin CA hoặc Let's Encrypt, nén Brotli/Gzip tại chỗ và duy trì HTTP/3 QUIC trên toàn bộ hệ thống.

#### B. Quy Tắc Bất Biến Dual-Network Pattern & Zero Generic Aliases
Tuyệt đối không bao giờ định nghĩa các alias chung chung (`db`, `postgres`, `redis`, `web`) trên mạng dùng chung `ops_bridge`:

```yaml
# docker-compose.prod.yml
networks:
  ops_bridge:
    external: true
  vantoi_internal:
    driver: bridge
    internal: true # Không thể truy cập từ bên ngoài

services:
  vantoi_postgres:
    image: postgres:17-alpine
    networks:
      - vantoi_internal # Database chỉ nằm trong mạng cô lập!
    # Tuyệt đối KHÔNG gán alias generic lên ops_bridge
```

Mỗi dịch vụ công khai nối vào `ops_bridge` bắt buộc phải có tiền tố định danh duy nhất (ví dụ `vantoi-prod-api`, `finance-valkey`).

#### C. Tinh Chỉnh Kernel: Swappiness = 10 & NVMe Emergency Cushion
Cấu hình hệ điều hành Linux để ưu tiên 100% tài nguyên RAM vật lý cho cơ sở dữ liệu, chỉ sử dụng ổ đĩa Swap như một chiếc đệm giảm sóc khẩn cấp khi hệ thống quá tải:

```bash
# /etc/sysctl.d/99-kido-frugal-tuning.conf
# Giảm thiểu swap, giữ buffer database trên RAM vật lý
vm.swappiness = 10

# Tối ưu hóa bộ đệm I/O khi ghi dữ liệu xuống đĩa NVMe
vm.dirty_ratio = 15
vm.dirty_background_ratio = 5

# Cho phép ứng dụng cấp phát bộ nhớ dự phòng
vm.overcommit_memory = 1
```

Đồng thời, áp đặt trần bộ nhớ cứng cho từng container bằng Docker Compose:

```yaml
services:
  heavy_worker:
    deploy:
      resources:
        limits:
          memory: 512M
        reservations:
          memory: 256M
```

---

### Kết Quả Đo Đạc Sau Tối Ưu

- **Số lượng container hoạt động**: Duy trì ổn định **32 container** cùng lúc (gồm 4 cụm PostgreSQL, 3 cụm Valkey, 8 Node.js APIs, 6 Next.js SPAs và bộ giám sát).
- **Mức RAM rảnh rỗi**: Luôn duy trì trên **2.8 GiB RAM vật lý khả dụng** trong suốt 18 tháng vận hành.
- **Thời gian Downtime**: Đạt 99.99% Uptime, không có bất kỳ sự cố OOM-Killer nào xảy ra đối với các cơ sở dữ liệu quan trọng.
