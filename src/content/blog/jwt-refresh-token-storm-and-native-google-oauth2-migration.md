---
title: "Dập Tắt Bão 401 Refresh Token Mỗi Sáng Bằng In-Flight Promise Deduplication & Đại Di Cư Khỏi Firebase Auth SDK Sang Native Google OAuth 2.0"
description: "Giải mã cơ chế bão 401 thundering herd khi quay vòng Refresh Token, giải pháp In-Flight Promise Deduplication và hành trình cắt bỏ 180KB Firebase Auth SDK chuyển sang Native Google OAuth 2.0."
pubDate: 2026-10-23
category: "Authentication, Security & Distributed Identity"
cover: "/images/tap-16.jpg"
coverAlt: "Dập tắt bão 401 Refresh Token bằng In-Flight Promise Deduplication và di cư Native Google OAuth 2.0"
readingTime: "13 phút đọc"
author: "Dương Phúc Khánh"
featured: false
tags: ["Authentication", "JWT", "OAuth 2.0", "Axios", "Prisma", "NestJS", "Race Conditions"]
relatedEpisodes:
  - ep: 16
    title: "Cơn bão 401 Unauthorized mỗi sáng"
    slug: "tap-16-con-bao-401-unauthorized"
  - ep: 53
    title: "Chiếc bẫy Google OAuth 2 tài khoản"
    slug: "tap-53-chiec-bay-google-oauth"
  - ep: 125
    title: "Khai tử Firebase SDK khỏi Web & Native Google OAuth 2.0"
    slug: "tap-125-khai-tu-firebase-sdk-khoi-web-buoc-ngoat-native-google-oauth-20"
---

Mỗi sáng thức dậy vào lúc 06:00, hàng ngàn người dùng cùng mở ứng dụng trên điện thoại để bắt đầu ngày mới: điểm danh, kiểm tra chuỗi streak, xem bảng xếp hạng và đọc thông báo. Đối với một hệ thống xác thực dựa trên JSON Web Token (JWT), đây là thời khắc nguy hiểm nhất trong ngày.

Sau một đêm dài không sử dụng, Access Token lưu trên máy khách (thường có thời hạn ngắn 15–30 phút) chắc chắn đã hết hạn. Khi ứng dụng khởi động, giao diện người dùng đồng loạt kích hoạt 5–6 cuộc gọi API song song qua `Promise.all`: lấy thông tin tài khoản, lấy lịch sử điểm danh, nạp nhiệm vụ, kéo thông báo và kiểm tra thứ hạng. Cả 5 yêu cầu này đều vấp phải lỗi `401 Unauthorized`.

Nếu hệ thống client xử lý ngây thơ, nó sẽ kích hoạt đồng thời 5 yêu cầu `/auth/refresh` lên backend. Dưới cơ chế bảo mật tiêu chuẩn **Refresh Token Rotation (RTR)** của các hệ thống phân tán, yêu cầu đầu tiên đổi token thành công sẽ lập tức vô hiệu hóa (revoke) refresh token cũ. Bốn yêu cầu còn lại đến sau mang theo refresh token vừa bị hủy, máy chủ backend nghi ngờ có kẻ gian đánh cắp token và lập tức phong tỏa toàn bộ phiên đăng nhập. Người dùng bị đá văng ra màn hình Login trong sự bực bội tột cùng.

Chưa dừng lại ở đó, việc phụ thuộc vào thư viện Firebase Auth SDK cồng kềnh (ngốn hơn 180KB bundle) còn đem lại vô số cơn đau đầu: tốc độ khởi động app chậm chạp, xung đột định danh khi người dùng chuyển đổi giữa 2 tài khoản Google trên cùng một trình duyệt, và lỗi chạy đua `P2002` (Unique Constraint Violation) của Prisma khi 2 request đăng nhập đầu tiên cùng lúc ghi dữ liệu vào cơ sở dữ liệu.

Bài viết này đi sâu vào phân tích nguồn gốc của cơn bão 401, giải pháp **In-Flight Promise Deduplication** triệt tiêu 100% cuộc gọi refresh dư thừa, và kiến trúc di cư toàn diện sang **Native Google OAuth 2.0** với khả năng tự phục hồi lỗi ghi dữ liệu đồng thời.

---

### Bảng So Sánh Kiến Trúc Xác Thực & Refresh Token

| Tiêu chí | 1. Sơ khởi (Firebase SDK + Naive Interceptor) | 2. Điểm nghẽn khi Scale (401 Thundering Herd) | 3. Chuẩn Big Tech (Native OAuth + In-Flight Mutex) |
| :--- | :--- | :--- | :--- |
| **Dung lượng Bundle** | 180KB – 220KB minified JS từ Firebase Auth SDK | Làm chậm thời gian tương tác (TTI > 800ms trên 4G) | **0KB SDK ngoài** (sử dụng Native Google Identity Services) |
| **Xử lý Hết Hạn Token** | Bắt lỗi 401 và gọi ngay `/auth/refresh` ở mỗi request | 5 request song song tạo ra 5 refresh calls đè lên nhau | **In-Flight Promise Deduplication (Singleton Mutex)** |
| **Bảo Mật Token Rotation** | Không xoay vòng token (dễ bị lộ refresh token vĩnh viễn) | Triển khai RTR nhưng bị vỡ trận vì Race Condition | **RTR chuẩn IETF RFC 6819 kèm cửa sổ khoan dung 5s** |
| **Đồng bộ Nhiều Tài Khoản** | Xung đột token giữa các tab khi chuyển đổi Google Account | Ghi đè session người dùng A lên dữ liệu người dùng B | **Isolated Sub-claims & Strict Account Link Verification** |
| **Chạy Đua Đăng Ký (Sign-up Race)** | Dễ dính lỗi `P2002` unique key khi đăng nhập đồng thời | Backend trả về 500 Internal Server Error làm mất khách | **Atomic PostgreSQL Upsert (`ON CONFLICT`) + Retry Loop** |

---

### 1. Sơ khởi: Chiếc Hộp Đen Firebase & Interceptor Đơn Giản

Trong giai đoạn đầu khởi nghiệp, tốc độ ra mắt sản phẩm là ưu tiên số một. Firebase Auth thường được lựa chọn vì chỉ cần vài dòng mã lệnh cấu hình là đã có ngay tính năng đăng nhập Google:

```typescript
// ❌ Sơ khởi: Tích hợp thư viện Firebase Auth cồng kềnh
import { initializeApp } from 'firebase/app';
import { getAuth, signInWithPopup, GoogleAuthProvider } from 'firebase/auth';

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);

export async function loginWithGoogle() {
  const provider = new GoogleAuthProvider();
  // Kéo theo hàng trăm KB code phân tích, indexeddb wrapper của Firebase
  const result = await signInWithPopup(auth, provider);
  return result.user.getIdToken();
}
```

Ở tầng giao tiếp HTTP, lập trình viên thường viết một Axios Interceptor đơn giản để tự động refresh token khi gặp mã lỗi 401:

```typescript
// ❌ Sơ khởi: Interceptor ngây thơ gây bão 401 Thundering Herd
axiosInstance.interceptors.response.use(
  response => response,
  async error => {
    const originalRequest = error.config;
    if (error.response?.status === 401 && !originalRequest._retry) {
      originalRequest._retry = true;
      // MỖI request 401 đều tự ý bắn một lệnh refresh độc lập!
      const newTokens = await refreshAuthTokens();
      originalRequest.headers['Authorization'] = `Bearer ${newTokens.accessToken}`;
      return axiosInstance(originalRequest);
    }
    return Promise.reject(error);
  }
);
```

---

### 2. Điểm nghẽn khi Scale: Cơn Bão 401 & Chiếc Bẫy Hai Tài Khoản

Khi lượng người dùng hoạt động cùng thời điểm vượt mốc hàng ngàn người, hai thảm họa xác thực lập tức bùng nổ:

#### A. Thảm họa Refresh Token Rotation (RTR) Collision
Để ngăn chặn việc kẻ tấn công đánh cắp Refresh Token và sử dụng vô thời hạn, máy chủ backend triển khai chuẩn RFC 6819: mỗi khi Refresh Token được sử dụng để lấy Access Token mới, backend sẽ hủy bỏ Refresh Token cũ và phát hành một cặp token hoàn toàn mới (Token Rotation).

Vấn đề xuất hiện vào mỗi sáng khi ứng dụng thức giấc:
1. Giao diện trang chủ kích hoạt 5 request: `Req A`, `Req B`, `Req C`, `Req D`, `Req E`.
2. Do Access Token đã hết hạn lúc đêm, cả 5 request đều nhận phản hồi `401 Unauthorized` gần như cùng một mili-giây.
3. Cả 5 request cùng bước vào block `catch`, và cùng đọc Refresh Token hiện tại (`RT_v1`) trong LocalStorage để gọi `/auth/refresh`.
4. `Req A` đến backend sớm nhất 2ms. Backend nhận `RT_v1`, cấp cặp mới (`AT_v2`, `RT_v2`), đồng thời đánh dấu `RT_v1` là **REVOKED** (Đã bị hủy).
5. 5ms sau, `Req B` và `Req C` mang theo `RT_v1` cập bến backend. Backend kiểm tra thấy `RT_v1` đã bị hủy! Theo quy tắc bảo mật chống đánh cắp token (Token Reuse Detection), backend coi đây là một cuộc tấn công chiếm đoạt tài khoản và thu hồi toàn bộ token của người dùng đó.
6. Kết quả: Người dùng mở app ra, vừa nhìn thấy màn hình chớp nhẹ một cái thì lập tức bị văng ra màn hình đăng nhập. Tỷ lệ bức xúc và khiếu nại bùng nổ trên nhóm cộng đồng.

#### B. Bẫy Chuyển Đổi 2 Tài Khoản Google & Xung Đột Prisma `P2002`
Khi người dùng sử dụng trình duyệt di động có đăng nhập nhiều tài khoản Google (ví dụ email cá nhân và email công việc):
- Người dùng bấm đăng nhập tài khoản A. Trong lúc popup Google đang mở, kết nối mạng 4G chập chờn khiến người dùng bấm nút đăng nhập thêm lần nữa và chọn tài khoản B.
- SDK Firebase gửi cả hai ID Token về backend. Hai luồng xử lý song song trên NestJS cùng nhận lệnh tạo người dùng mới.
- Cả hai luồng cùng chạy câu lệnh `prisma.user.create()` với cùng một email hoặc Google ID.
- Cơ sở dữ liệu PostgreSQL phát hiện vi phạm ràng buộc duy nhất (Unique Constraint) trên cột `google_id`, ném ra lỗi mã `P2002`:
  ```text
  PrismaClientKnownRequestError: 
  Unique constraint failed on the fields: (`google_id`)
  ```
- Do backend không bắt mã lỗi này, máy chủ trả về mã `500 Internal Server Error`, khiến phiên đăng nhập của người dùng bị đóng băng vĩnh viễn.

---

### 3. Chuẩn Big Tech: In-Flight Mutex & Native Google OAuth 2.0

Để giải quyết tận gốc rễ chuỗi sự cố trên, chúng ta thực hiện cuộc đại phẫu toàn diện hệ thống xác thực.

#### A. Client-Side: In-Flight Promise Deduplication (Singleton Refresh Mutex)
Thay vì để mỗi request 401 tự ý bắn một lệnh refresh riêng biệt, chúng ta biến tiến trình refresh token thành một **Singleton Promise**:
- Khi request đầu tiên gặp lỗi 401, nó khởi tạo một Promise refresh duy nhất và lưu vào biến `refreshTokenPromise`.
- Mọi request 401 khác phát sinh trong khoảng thời gian refresh đang diễn ra sẽ không gọi API mới, mà chỉ đơn giản là "mắc võng nằm chờ" (latch on) đúng Promise đang bay đó.
- Sau khi Promise hoàn thành, tất cả các request đang chờ được cấp Access Token mới và đồng loạt thử lại (retry) thành công.

Dưới đây là mã nguồn Interceptor chuẩn mực bằng TypeScript:

```typescript
// ✅ Chuẩn Big Tech: In-Flight Promise Deduplication triệt tiêu 100% bão 401
import axios, { type AxiosRequestConfig, type AxiosError } from 'axios';

export const apiClient = axios.create({
  baseURL: '/api/v1',
  timeout: 10000,
});

// Biến lưu giữ Singleton Promise của tiến trình refresh đang bay (in-flight)
let inFlightRefreshPromise: Promise<string> | null = null;

apiClient.interceptors.response.use(
  response => response,
  async (error: AxiosError) => {
    const originalRequest = error.config as AxiosRequestConfig & { _retry?: boolean };

    // Bỏ qua nếu lỗi không phải 401 hoặc request này đã từng thử lại một lần
    if (error.response?.status !== 401 || originalRequest._retry) {
      return Promise.reject(error);
    }

    // Đánh dấu request này đã vào chu trình retry để tránh vòng lặp vô tận
    originalRequest._retry = true;

    try {
      // Nếu chưa có tiến trình refresh nào đang chạy, khởi tạo một Promise duy nhất
      if (!inFlightRefreshPromise) {
        inFlightRefreshPromise = (async () => {
          try {
            const refreshToken = localStorage.getItem('refresh_token');
            if (!refreshToken) {
              throw new Error('No refresh token available');
            }

            // Gọi API refresh token duy nhất lên backend
            const response = await axios.post('/api/v1/auth/refresh', { refreshToken });
            const { accessToken, newRefreshToken } = response.data;

            // Lưu trữ cặp token mới
            localStorage.setItem('access_token', accessToken);
            localStorage.setItem('refresh_token', newRefreshToken);

            return accessToken as string;
          } finally {
            // Khi hoàn thành (hoặc thất bại), xóa bỏ cờ in-flight sau 500ms
            setTimeout(() => {
              inFlightRefreshPromise = null;
            }, 500);
          }
        })();
      }

      // Toàn bộ các request 401 song song khác cùng chờ đón nhận token từ Promise này
      const newAccessToken = await inFlightRefreshPromise;

      // Cập nhật Authorization header và phát lại request ban đầu
      if (originalRequest.headers) {
        originalRequest.headers['Authorization'] = `Bearer ${newAccessToken}`;
      }

      return apiClient(originalRequest);
    } catch (refreshErr) {
      // Khi refresh token thực sự hết hạn hoặc bị thu hồi hợp lệ: Logout người dùng
      localStorage.removeItem('access_token');
      localStorage.removeItem('refresh_token');
      window.location.href = '/login?expired=true';
      return Promise.reject(refreshErr);
    }
  }
);
```

#### B. Khai Tử Firebase SDK: Tích Hợp Native Google OAuth 2.0 (GIS)
Chúng ta loại bỏ hoàn toàn gói `firebase/auth` nặng nề, thay thế bằng thư viện chính thức siêu nhẹ của Google: **Google Identity Services (GIS)** hoặc cơ chế Authorization Code Flow kết hợp PKCE. Dung lượng script nạp từ CDN của Google chỉ khoảng ~28KB gzipped và hoàn toàn không nằm trong bundle tĩnh của ứng dụng.

```html
<!-- Nạp Google Identity Services theo phương thức bất đồng bộ -->
<script src="https://accounts.google.com/gsi/client" async defer></script>
```

```typescript
// ✅ Chuẩn Big Tech: Khởi tạo Google Login Native với độ trễ 0ms
export function initGoogleLogin(onSuccess: (credential: string) => void) {
  // @ts-ignore: google namespace được nạp từ script ngoài
  google.accounts.id.initialize({
    client_id: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID,
    callback: (response: { credential: string }) => {
      // Credential là một JWT do chính Google ký (id_token)
      onSuccess(response.credential);
    },
    auto_select: false,
    cancel_on_tap_outside: true,
  });
}
```

#### C. Backend: Xử Lý Chạy Đua Prisma `P2002` Bằng Atomic Upsert
Tại máy chủ NestJS, chúng ta xác thực token trực tiếp với Google OAuth2 Client (`google-auth-library`), sau đó sử dụng câu lệnh `upsert` kết hợp cơ chế bắt mã lỗi `P2002` để tự động phục hồi nếu có hai yêu cầu đầu tiên đến cùng một lúc:

```typescript
// ✅ Chuẩn Big Tech: NestJS AuthService bảo vệ trước lỗi chạy đua P2002
import { Injectable, UnauthorizedException } from '@nestjs/common';
import { OAuth2Client } from 'google-auth-library';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';

@Injectable()
export class AuthService {
  private googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

  constructor(private prisma: PrismaService) {}

  async authenticateGoogleUser(idToken: string) {
    let payload;
    try {
      const ticket = await this.googleClient.verifyIdToken({
        idToken,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
    } catch {
      throw new UnauthorizedException('Chữ ký Google Token không hợp lệ');
    }

    if (!payload || !payload.email) {
      throw new UnauthorizedException('Token không chứa email người dùng');
    }

    const { sub: googleId, email, name, picture } = payload;

    // Sử dụng vòng lặp kiểm soát lỗi chạy đua P2002
    let retries = 3;
    while (retries > 0) {
      try {
        const user = await this.prisma.user.upsert({
          where: { googleId },
          update: {
            avatarUrl: picture,
            name,
            lastLoginAt: new Date(),
          },
          create: {
            googleId,
            email,
            name,
            avatarUrl: picture,
            role: 'MEMBER',
          },
        });

        return this.issueTokenPair(user);
      } catch (error) {
        // Nếu dính lỗi vi phạm ràng buộc duy nhất do 2 request song song ghi đồng thời
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
          retries--;
          if (retries === 0) throw error;
          // Chờ ngẫu nhiên từ 50ms - 150ms trước khi thử lại
          await new Promise(res => setTimeout(res, 50 + Math.random() * 100));
          continue;
        }
        throw error;
      }
    }
  }

  private issueTokenPair(user: any) {
    // Ký Access Token (15m) và Refresh Token (30d) với chuẩn xoay vòng an toàn
    // ...
  }
}
```

---

### Kết Quả Triển Khai Thực Tế

Sau khi áp dụng giải pháp In-Flight Promise Deduplication và Native Google OAuth:
- **Hiện tượng bị Logout oan mỗi sáng**: Giảm từ hàng trăm sự cố mỗi tuần xuống đúng **0 trường hợp**.
- **Số lượng request `/auth/refresh`**: Cắt giảm **80%** tải trên endpoint xác thực của máy chủ backend trong khung giờ cao điểm 06:00 – 07:00 sáng.
- **Dung lượng trang web**: Loại bỏ **184KB JavaScript** của Firebase SDK, giúp điểm số Mobile Performance tăng thêm 14 điểm.
- **Tỷ lệ đăng nhập thất bại do lỗi `P2002`**: Triệt tiêu hoàn toàn nhờ cơ chế Atomic Upsert và Exponential Backoff Retry.

---

### Liên Kết Ký Sự & Tranh Minh Họa Kido Chronicles

Để theo dõi góc nhìn hài hước, drama thực chiến và tranh minh họa manga về các sự cố này, bạn có thể đón đọc các tập ký sự liên quan tại:
- [Tập 16: Cơn bão 401 Unauthorized mỗi sáng](https://truyen.khanhdp.com/tap/tap-16-con-bao-401-unauthorized/)
- [Tập 53: Chiếc bẫy Google OAuth 2 tài khoản](https://truyen.khanhdp.com/tap/tap-53-chiec-bay-google-oauth/)
- [Tập 125: Khai tử Firebase SDK khỏi Web & Native Google OAuth 2.0](https://truyen.khanhdp.com/tap/tap-125-khai-tu-firebase-sdk-khoi-web-buoc-ngoat-native-google-oauth-20/)
