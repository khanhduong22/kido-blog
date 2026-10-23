---
title: "Thiết Kế Bảng Xếp Hạng Triệu View Với Chi Phí $0: Valkey Sorted Set (ZADD / ZREVRANGE O(log N)) & 180-Byte Bitmap Thay Thế PostgreSQL ORDER BY SUM()"
description: "Kiến trúc bảng xếp hạng thời gian thực phục vụ hàng trăm ngàn người dùng: Chuyển dịch từ câu lệnh SQL ORDER BY đắt đỏ sang Valkey SkipList và cấu trúc dữ liệu Bitmap siêu tiết kiệm RAM."
pubDate: 2026-10-23
category: "Database & High-Concurrency Caching"
cover: "https://cdn.khanhdp.com/chronicles/tap-7.webp"
coverAlt: "Kiến trúc bảng xếp hạng triệu view bằng Valkey Sorted Set và Bitmap"
readingTime: "12 phút đọc"
author: "Dương Phúc Khánh"
featured: true
tags: ["Valkey", "Redis", "PostgreSQL", "Database", "High Concurrency", "Data Structures"]
relatedEpisodes:
  - ep: 7
    title: "Valkey leaderboard"
    slug: "tap-7-valkey-leaderboard"
  - ep: 17
    title: "Fast session token bridge"
    slug: "tap-17-fast-session-token-bridge"
  - ep: 71
    title: "Chiếc phao cứu sinh 30 giây Valkey Cache-Aside"
    slug: "tap-71-chiec-phao-cuu-sinh-30-giay-valkey"
  - ep: 81
    title: "Tách dòng máu Staging & Prod trên Valkey"
    slug: "tap-81-phan-chia-dong-mau-valkey-staging-prod"
  - ep: 113
    title: "Vụ án 3 tiếng deep work bốc hơi và chiếc phao cứu sinh 944 điểm"
    slug: "tap-113-vu-an-3-tieng-deep-work-boc-hoi-va-chiec-phao-cuu-sinh-944-diem"
---

Trong mọi hệ thống mạng xã hội, game hoặc nền tảng học tập, tính năng Bảng xếp hạng (Leaderboard) là thỏi nam châm giữ chân người dùng mạnh mẽ nhất. Tuy nhiên, đằng sau màn hình hiển thị Top 100 long lanh là một bài toán hóc búa về chi phí tính toán. Cứ mỗi khi một học viên hoàn thành một bài học và được cộng 10 điểm, hệ thống phải cập nhật thứ hạng của toàn bộ hàng trăm ngàn người dùng khác.

Nếu giải quyết bài toán này bằng cơ sở dữ liệu quan hệ truyền thống như PostgreSQL, bạn sẽ sớm phải chi trả hàng ngàn USD tiền nâng cấp phần cứng chỉ để máy chủ khỏi bị nghẽn CPU. Bài viết này hướng dẫn cách xây dựng Leaderboard thời gian thực xử lý hàng chục ngàn thao tác mỗi giây chỉ với 0 USD chi phí phần cứng bổ sung thông qua Valkey (nhánh mã nguồn mở hoàn toàn tương thích Redis).

---

### Bảng So Sánh Kiến Trúc Bảng Xếp Hạng

| Tiêu chí | 1. Sơ khởi (PostgreSQL Naive) | 2. Điểm nghẽn khi Scale | 3. Chuẩn Big Tech (Valkey ZSET + Bitmap) |
| :--- | :--- | :--- | :--- |
| **Độ phức tạp ghi điểm** | `INSERT INTO scores...` $O(1)$ | Khóa bảng khi tính toán tổng điểm | `ZADD leaderboard <score> <uid>` $O(\log N)$ |
| **Lấy Top 100 bảng** | `ORDER BY SUM(points) DESC` $O(N \log N)$ | Quét hàng triệu dòng, ngốn 100% CPU DB | `ZREVRANGE leaderboard 0 99` $O(\log N + M)$ |
| **Lấy hạng cá nhân** | `DENSE_RANK() OVER (...)` $O(N \log N)$ | Bắt buộc quét toàn bộ bảng dữ liệu | `ZREVRANK leaderboard <uid>` $O(\log N)$ |
| **Độ trễ phản hồi (p99)** | ~3,500ms – 12,000ms | Sập Connection Pool (504 Gateway Timeout) | **< 1.5ms (In-Memory Sub-millisecond)** |
| **Dung lượng lưu streak** | Bảng lịch sử 365 rows $\approx$ 18KB/user/năm | Dung lượng DB phình to hàng trăm Gigabyte | **Bitmap: Đúng 46 byte / user / năm!** |

---

### 1. Sơ khởi (Naive Approach: SQL Aggregation)

Các dự án ban đầu thường tận dụng ngay database quan hệ có sẵn:
```sql
-- ❌ Sơ khởi: Câu query "hủy diệt" database khi bảng chạm ngưỡng 500k dòng
SELECT 
  user_id, 
  SUM(points) AS total_score,
  DENSE_RANK() OVER (ORDER BY SUM(points) DESC) AS rank
FROM scores
WHERE created_at >= '2026-10-01'
GROUP BY user_id
ORDER BY total_score DESC
LIMIT 100;
```

Về mặt logic nghiệp vụ, câu truy vấn này hoàn hảo: tính toán chính xác tổng điểm của từng người và gán thứ hạng tương ứng.

---

### 2. Điểm nghẽn khi Scale (Scale Bottlenecks & Failure Modes)

Khi hệ thống có 200,000 người dùng tích cực và bảng `scores` tích lũy 5,000,000 bản ghi:
1. **Chi Phí Tính Toán Bùng Nổ**: Để lấy Top 100, PostgreSQL phải thực hiện Sequential Scan qua 5 triệu dòng, nạp vào bộ nhớ RAM tạm thời (`Sort Space`), chạy thuật toán Quicksort trên toàn bộ 200,000 nhóm. Thời gian thực thi nhảy vọt từ 45ms lên **4,800ms**.
2. **Thắt Cổ Chai Connection Pool**: Trong giờ cao điểm (ví dụ 21:00 tối), hàng ngàn học sinh cùng mở trang xếp hạng. Mỗi request giữ chặt 1 database connection trong gần 5 giây. Chỉ sau 30 giây, connection pool cạn kiệt, các API thanh toán và đăng nhập quan trọng khác lập tức bị chết chùm với lỗi `Connection pool exhausted`.
3. **Bài Toán Rank Cá Nhân**: Khi người dùng ở hạng 84,200 muốn biết mình đang đứng thứ mấy, câu lệnh `DENSE_RANK()` vẫn buộc phải tính toán lại toàn bộ dữ liệu của 84,199 người xếp trên họ.

---

### 3. Chuẩn Big Tech Production (Tier-1 Architecture: Valkey ZSET & Bitmap)

Để đưa chi phí vận hành về tối thiểu và đạt tốc độ phản hồi tính bằng micro-giây, hệ thống chuyển sang sử dụng hai cấu trúc dữ liệu chuyên biệt của Valkey:

#### A. Valkey Sorted Set (ZSET) với Cấu Trúc Dữ Liệu SkipList
Valkey ZSET kết hợp giữa một **Hash Table** (ánh xạ `member -> score` với độ phức tạp $O(1)$) và một **SkipList đa tầng** (sắp xếp các phần tử theo thứ tự điểm số với độ phức tạp $O(\log N)$).

```
Level 4:  [Head] ------------------------------> [User_C: 950] -> NIL
Level 3:  [Head] ---------------> [User_B: 800] -> [User_C: 950] -> NIL
Level 2:  [Head] -> [User_A: 450] -> [User_B: 800] -> [User_C: 950] -> NIL
Level 1:  [Head] -> [User_A: 450] -> [User_B: 800] -> [User_C: 950] -> NIL
```

Mỗi thao tác ghi điểm `ZINCRBY` hay tra cứu thứ hạng chỉ duyệt qua tối đa vài node của danh sách nhảy, biến bài toán tính toán từ nặng nề thành một thao tác máy học cực nhẹ:

```typescript
// ✅ Chuẩn Big Tech: Service bảng xếp hạng thời gian thực với Valkey Pipeline
@Injectable()
export class ValkeyLeaderboardService {
  constructor(@Inject('VALKEY_CLIENT') private readonly valkey: Valkey) {}

  private getKey(weekSlug: string) {
    return `leaderboard:season:${weekSlug}`;
  }

  // Cập nhật điểm nguyên tử trong O(log N)
  async incrementUserScore(weekSlug: string, userId: string, deltaPoints: number): Promise<number> {
    const key = this.getKey(weekSlug);
    return await this.valkey.zincrby(key, deltaPoints, userId);
  }

  // Lấy Top N kèm điểm số trong O(log N + M)
  async getTopLeaders(weekSlug: string, limit = 100): Promise<{ userId: string; score: number; rank: number }[]> {
    const key = this.getKey(weekSlug);
    // Lấy danh sách từ cao xuống thấp
    const results = await this.valkey.zrevrange(key, 0, limit - 1, 'WITHSCORES');
    
    const leaders = [];
    for (let i = 0; i < results.length; i += 2) {
      leaders.push({
        userId: results[i],
        score: parseFloat(results[i + 1]),
        rank: Math.floor(i / 2) + 1,
      });
    }
    return leaders;
  }

  // Lấy vị trí thứ hạng của chính người dùng hiện tại trong O(log N)
  async getUserRank(weekSlug: string, userId: string): Promise<{ rank: number | null; score: number | null }> {
    const key = this.getKey(weekSlug);
    const pipeline = this.valkey.pipeline();
    pipeline.zrevrank(key, userId);
    pipeline.zscore(key, userId);
    
    const [[err1, rank], [err2, score]] = await pipeline.exec();
    return {
      rank: rank !== null ? (rank as number) + 1 : null,
      score: score !== null ? parseFloat(score as string) : null,
    };
  }
}
```

#### B. Cấu Trúc 180-Byte Bitmap Lưu Trữ Chuỗi Hoạt Động (Streak)
Thay vì tạo bảng `checkin_logs` với 365 bản ghi mỗi năm cho mỗi người dùng (tốn ít nhất 18KB dung lượng index và dòng trong PostgreSQL), chúng ta sử dụng chuỗi bit:
- 1 năm có 365 ngày tương ứng đúng **365 bit = 46 byte**.
- Với 4 chỉ số theo dõi khác nhau (Học tập, Rèn luyện, Đọc sách, Thiền), toàn bộ lịch sử 1 năm của người dùng chỉ chiếm vỏn vẹn **184 byte** bộ nhớ!

```bash
# Đánh dấu ngày thứ 296 trong năm người dùng đã học
SETBIT user:streak:2026:usr_9981 296 1

# Đếm tổng số ngày đã hoàn thành trong năm (O(1) bằng SIMD CPU instructions)
BITCOUNT user:streak:2026:usr_9981
```

---

### Số Liệu Hiệu Năng Thực Tế

- **Độ trễ API Top 100**: Giảm từ `4,850ms` (PostgreSQL) xuống còn **`0.8ms`** (Valkey in-memory).
- **Mức tiêu hao CPU Database chính**: Giảm từ 92% tải liên tục xuống dưới 8%.
- **Dung lượng RAM cần thiết**: Phục vụ 500,000 người dùng xếp hạng chỉ tiêu tốn vỏn vẹn **64MB RAM** của Valkey, hoàn toàn chạy êm ru trên một VPS giá rẻ mà không tốn thêm 1 xu tiền hạ tầng.
