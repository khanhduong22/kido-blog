---
title: "Đại Phẫu Thuật State Management: Chặn Đứng 4 Request Trùng Lặp Lúc Mount, Xoá Sổ Bóng Ma Redux State Rollover & Khai Tử 6.400 Dòng Redux Bằng Zustand + TanStack Query"
description: "Phân tích kiến trúc chuyển đổi toàn diện từ Redux sang TanStack Query + Zustand: Cơ chế triệt tiêu 4 request trùng lặp (In-Flight Deduplication), xóa sổ lỗi Redux State Rollover nửa đêm và tối giản 6.400 dòng boilerplate."
pubDate: 2026-10-23
category: "Frontend Architecture & State Management"
cover: "/images/tap-43.jpg"
coverAlt: "Đại Phẫu Thuật State Management: In-Flight Request Deduplication, Zustand và TanStack Query"
readingTime: "12 phút đọc"
author: "Dương Phúc Khánh"
featured: false
tags: ["React", "State Management", "TanStack Query", "Zustand", "Redux", "Frontend Performance", "Request Deduplication"]
relatedEpisodes:
  - ep: 61
    title: "Cơn ác mộng 4 request trùng lặp cùng lúc"
    slug: "tap-61-con-ac-mong-4-request-trung-lap"
  - ep: 112
    title: "Cú nuốt chửng điểm số của Redux State Rollover"
    slug: "tap-112-cu-nuot-chung-diem-so-cua-redux-state-rollover"
  - ep: 116
    title: "Đại phẫu thuật State Management: Zustand & TanStack Query"
    slug: "tap-116-dai-phau-thuat-state-management-zustand-tanstack-query"
  - ep: 118
    title: "Cuộc khai tử 6.400 dòng Redux"
    slug: "tap-118-cuoc-khai-tu-6400-dong-redux-cu-lat-do-the-ky-cua-zustand-tanstack-query"
---

Trong hành trình tiến hóa của một ứng dụng React/Next.js quy mô lớn, **Quản lý Trạng thái (State Management)** luôn là chiến trường khốc liệt nhất. Đã có một thời kỳ dài, Redux (và Redux Toolkit) được coi là "tiêu chuẩn vàng bất khả xâm phạm" cho mọi dự án. Bất kỳ dữ liệu nào — từ thông tin hồ sơ người dùng, danh sách thông báo, cho đến trạng thái bật/tắt của một chiếc menu — đều bị tống chung vào một chiếc "kho tổng" khổng lồ (Global Store).

Nhưng khi ứng dụng mở rộng với hàng chục component phức tạp cùng hiển thị trên một màn hình, sự cồng kềnh của kiến trúc này bắt đầu phản bội lại chính người tạo ra nó: 4 component độc lập cùng mount sẽ bắn 4 request `GET /api/me` giống hệt nhau lên máy chủ; cơ chế lưu đệm ngây thơ `redux-persist` làm sống dậy bóng ma dữ liệu cũ nuốt chửng điểm số lúc nửa đêm; và đội ngũ kỹ sư phải oằn mình bảo trì hơn 6.400 dòng code boilerplate thừa thãi.

Đây là bản tường trình chi tiết về cuộc **Đại Phẫu Thuật State Management**: tách rời triệt để giữa **Server State** và **Client UI State**, khai tử Redux và thiết lập chuẩn mực mới với **TanStack Query + Zustand**.

---

### Bảng So Sánh Kiến Trúc Quản Lý Trạng Thái

| Tiêu chí kỹ thuật | 1. Sơ khởi (Redux Monolith) | 2. Điểm nghẽn khi Scale (Scale Bottlenecks) | 3. Chuẩn Big Tech (TanStack Query + Zustand) |
| :--- | :--- | :--- | :--- |
| **Bản chất quản lý dữ liệu** | Gom chung Server Cache và Client UI vào 1 Store duy nhất | Trộn lẫn dữ liệu bất đồng bộ (Async) và đồng bộ (Sync), gây rò rỉ bộ nhớ | **Tách rời tuyệt đối**: TanStack Query quản lý Server State; Zustand quản lý Client UI State |
| **Trùng lặp Request khi Mount** | Mỗi component con tự gọi `dispatch(fetchUserData())` trong `useEffect` | 4 component anh em cùng mount bắn 4 HTTP requests giống hệt nhau trong cùng 16ms | **In-Flight Request Deduplication**: Chia sẻ chung 1 Promise duy nhất theo `queryKey`, triệt tiêu 100% request trùng |
| **Tính tươi mới của dữ liệu** | Thủ công viết reducer cập nhật cờ `isFetching`, `isSuccess`, `error` | Dữ liệu bị thiu (stale), phải nhớ dispatch fetch lại ở khắp mọi trang | **Stale-While-Revalidate (SWR)**: Định nghĩa `staleTime`, tự động revalidate ngầm khi window focus/reconnect |
| **Lưu đệm ngoại tuyến (Persist)** | `redux-persist` serialize toàn bộ store đè vào `localStorage` | **Redux State Rollover**: Hydration lúc 00:05 nạp lại dữ liệu hôm qua, ghi đè outbox điểm danh | **Selective Client Persistence**: Chỉ persist UI State (theme, sidebar); Server State để QueryClient quản lý |
| **Độ phức tạp mã nguồn (Boilerplate)** | Rừng file Actions, Reducers, Types, Thunks, Selectors (6.400+ dòng) | Khó tái cấu trúc, onboarding kỹ sư mới mất cả tuần, bundle size phình to | **Minimalist Architecture**: Xóa sổ 6.400 dòng Redux, thay bằng < 300 dòng Zustand và Custom Query Hooks |

---

### 1. Cơn Ác Mộng 4 Request Trùng Lặp Cùng Lúc (The 4-Concurrent-Request Waterfall)

Hãy quan sát một Dashboard quen thuộc trong ứng dụng. Khi người dùng đăng nhập và mở trang chủ:

```
[Header Navigation]
  ├── <UserAvatar />         ──> useEffect() ──> dispatch(fetchCurrentUser())
  ├── <StreakCounter />       ──> useEffect() ──> dispatch(fetchCurrentUser())
  └── <NotificationBell />    ──> useEffect() ──> dispatch(fetchCurrentUser())
[Main Content]
  └── <UserProfileSummary /> ──> useEffect() ──> dispatch(fetchCurrentUser())
```

Trong thế giới Redux cổ điển, do 4 component này là các thực thể độc lập được phát triển bởi các module khác nhau, mỗi component đều cần thông tin của người dùng hiện tại (`user.id`, `user.name`, `user.avatar`, `user.points`).
Mỗi component tự phòng thủ bằng cách đặt một `useEffect`:

```tsx
// ❌ Sơ khởi: Tư duy phòng thủ cục bộ bằng Redux Thunk
useEffect(() => {
  dispatch(fetchCurrentUserThunk());
}, [dispatch]);
```

#### Hậu quả trên Network Waterfall:
Cả 4 component cùng được React render trong **cùng một microtask tick** (chưa đầy 16ms).
Kết quả là trình duyệt mở đồng loạt **4 kết nối HTTP song song** tới endpoint:
`GET /api/me`
`GET /api/me`
`GET /api/me`
`GET /api/me`

Máy chủ backend NestJS phải giải mã JWT 4 lần, truy vấn cơ sở dữ liệu PostgreSQL 4 lần, ngốn connection pool gấp 4 lần hoàn toàn vô nghĩa!

#### Cơ Chế Giải Quyết: In-Flight Request Deduplication Của TanStack Query
TanStack Query giải quyết bài toán này ở tầng kiến trúc lõi thông qua **Promise Sharing Map**.

```
Component A (Mount) ──> QueryClient.fetch(['me']) ──> Tạo Promise P1 ──> [HTTP Request Đang Bay]
Component B (Mount) ──> QueryClient.fetch(['me']) ──> Thấy P1 đang Pending ──┐
Component C (Mount) ──> QueryClient.fetch(['me']) ──> Thấy P1 đang Pending ──┼──> Cùng Await P1!
Component D (Mount) ──> QueryClient.fetch(['me']) ──> Thấy P1 đang Pending ──┘
                                                                               │
                                            HTTP Trả Về Kết Quả ───────────────┘
                                                       │
                                        Phát tán kết quả cho cả A, B, C, D
```

```typescript
// ✅ Chuẩn Big Tech: Custom Query Hook với In-Flight Deduplication & Stale Management
import { useQuery } from '@tanstack/react-query';
import { apiClient } from '@/lib/api-client';

export interface CurrentUser {
  id: string;
  name: string;
  avatarUrl: string;
  currentStreak: number;
  totalPoints: number;
}

export const currentUserQueryKey = ['auth', 'me'] as const;

export function useCurrentUser() {
  return useQuery({
    queryKey: currentUserQueryKey,
    queryFn: async () => {
      const response = await apiClient.get<CurrentUser>('/api/me');
      return response.data;
    },
    // Dữ liệu được coi là "tươi" trong 2 phút - Không bao giờ fetch lại nếu chưa quá 2 phút
    staleTime: 2 * 60 * 1000,
    // Giữ trong bộ nhớ cache RAM 10 phút sau khi toàn bộ component unmount
    gcTime: 10 * 60 * 1000,
    // Ngăn chặn giật lag khi chuyển tab
    refetchOnWindowFocus: false,
  });
}
```

Bất kể có 1 component hay 100 component cùng gọi `useCurrentUser()` đồng thời trên màn hình, **chỉ có duy nhất 1 request mạng được phát đi**. Tải trọng mạng và tải CPU backend lập tức giảm 75%!

---

### 2. Bóng Ma Redux State Rollover: Cú Nuốt Chửng Điểm Số Lúc Nửa Đêm

Một trong những sự cố bí ẩn và đau đầu nhất từng khiến đội ngũ kỹ sư mất ngủ là lỗi: **Điểm danh xong bị mất điểm lúc 00:05**.

Học viên A vừa hoàn thành bài tập lúc 23:59 đêm qua, đạt 100 điểm. Sang 00:05 sáng, học viên mở lại ứng dụng trên điện thoại để khoe với bạn bè. Đập vào mắt họ: Điểm số trở về của ngày hôm kia, bài tập hôm qua hiển thị trạng thái "Chưa hoàn thành"! Họ hoảng hốt nộp lại, nhưng hệ thống báo lỗi xung đột.

#### Nguyên Nhân Gốc Rễ: Sự Ngây Thơ Của `redux-persist`
Để ứng dụng nạp nhanh và mở được khi offline, dự án cũ sử dụng `redux-persist` để lưu toàn bộ trạng thái của Redux Store vào `localStorage`.

```typescript
// ❌ Sơ khởi: Persist vô tội vạ toàn bộ cây State
const persistConfig = {
  key: 'root',
  storage,
  whitelist: ['auth', 'dashboard', 'disciplineLogs'], // Chứa cả Server Data!
};
```

1. Lúc 23:40 đêm hôm qua, người dùng mở app. State lúc đó được lưu vào `localStorage` với `points: 80`, `streak: 10`.
2. Lúc 23:58, người dùng làm bài tập offline hoặc nộp qua Mutation Outbox.
3. Lúc 00:05 sáng hôm sau, người dùng mở lại app. `redux-persist` thực hiện quá trình **Hydration** đồng bộ từ `localStorage` đè thẳng lên Redux Store trước khi bất kỳ API nào kịp phản hồi.
4. Kết quả: Toàn bộ dữ liệu cũ của ngày hôm trước (State Rollover) hồi sinh như một bóng ma, xóa sạch trạng thái mới nhất và làm sai lệch giao diện người dùng!

#### Triết Lý Chuẩn Big Tech: Server State Không Phải Là Client UI State
Để diệt trừ tận gốc bóng ma State Rollover, chúng ta phải phân định rạch ròi bản chất của hai loại dữ liệu:

1. **Server State (Dữ liệu của Máy Chủ)**:
   - Dữ liệu này thuộc quyền sở hữu của Backend và Database.
   - Frontend chỉ đang mượn một "ảnh chụp nhanh" (Snapshot) có tính chất tạm thời.
   - **Công cụ duy nhất**: `TanStack Query`. Không bao giờ persist thô toàn bộ dữ liệu này vào `localStorage` nếu không có cơ chế xác thực phiên và kiểm tra độ tươi (`staleTime`).

2. **Client UI State (Trạng thái Giao diện Cục Bộ)**:
   - Trạng thái Sidebar đang mở hay đóng (`isSidebarOpen`).
   - Giao diện Sáng hay Tối (`theme: 'dark' | 'light'`).
   - Tọa độ cuộn trang hoặc form nháp đang gõ dở.
   - **Công cụ duy nhất**: `Zustand`.

---

### 3. Cuộc Khai Tử 6.400 Dòng Boilerplate: Chuyển Sang Zustand Tinh Gọn

Trước cuộc đại phẫu, cây thư mục Redux của dự án là một ma trận phức tạp:

```
src/store/
  ├── actions/          (12 files, 1.400 dòng)
  ├── reducers/         (14 files, 1.800 dòng)
  ├── thunks/           (8 files, 1.200 dòng)
  ├── types/            (10 files, 900 dòng)
  ├── selectors/        (6 files, 600 dòng)
  └── index.ts          (Store configuration & persist middleware: 500 dòng)
===> TỔNG CỘNG: HƠN 6.400 DÒNG BOILERPLATE!
```

Mỗi lần thêm một thuộc tính nhỏ như `isFilterOpen`, lập trình viên phải sửa ít nhất 5 file: tạo action type, định nghĩa action creator, sửa reducer case, viết selector có `createSelector`, và cập nhật root state interface.

#### Thay Thế Bằng Zustand Micro-Store: Dưới 50 Dòng, Hiệu Năng Vượt Trội
Zustand hoạt động dựa trên cơ chế Pub/Sub tối giản, không cần Context Provider bao bọc ngoài cùng cây component, và hỗ trợ **Selector-based Re-render** chuẩn mực:

```typescript
// ✅ Chuẩn Big Tech: Zustand Store siêu tinh gọn cho Client UI State
// File: src/stores/useUiStore.ts
import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';

interface UiState {
  theme: 'dark' | 'light';
  isSidebarOpen: boolean;
  activeExerciseTab: 'all' | 'pullup' | 'pushup' | 'handstand';
  toggleSidebar: () => void;
  setTheme: (theme: 'dark' | 'light') => void;
  setActiveExerciseTab: (tab: 'all' | 'pullup' | 'pushup' | 'handstand') => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      theme: 'dark',
      isSidebarOpen: false,
      activeExerciseTab: 'all',

      toggleSidebar: () => set((state) => ({ isSidebarOpen: !state.isSidebarOpen })),
      setTheme: (theme) => set({ theme }),
      setActiveExerciseTab: (activeExerciseTab) => set({ activeExerciseTab }),
    }),
    {
      name: 'kido-ui-storage', // Khóa lưu trữ cục bộ
      storage: createJSONStorage(() => localStorage),
      // Chỉ lưu trữ theme và tab, KHÔNG LƯU trữ dữ liệu nhạy cảm của server
      partialize: (state) => ({ theme: state.theme, activeExerciseTab: state.activeExerciseTab }),
    }
  )
);
```

#### Selector Tối Ưu Từng Micro-Second
Khi sử dụng trong React Component, component chỉ bị re-render khi giá trị mà nó thực sự quan tâm thay đổi:

```tsx
// Chỉ re-render khi isSidebarOpen thay đổi, bỏ qua hoàn toàn theme hay activeExerciseTab!
const isSidebarOpen = useUiStore((state) => state.isSidebarOpen);
const toggleSidebar = useUiStore((state) => state.toggleSidebar);
```

---

### 4. Kết Hợp Sức Mạnh: Optimistic Mutation Với TanStack Query

Hãy xem cách TanStack Query thực hiện cập nhật lạc quan (Optimistic Update) cho tính năng tích điểm điểm danh mà không cần viết một dòng Redux reducer nào:

```typescript
// ✅ Chuẩn Big Tech: Optimistic Update điểm số tức thì với Rollback tự động
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { currentUserQueryKey, CurrentUser } from './useCurrentUser';
import { apiClient } from '@/lib/api-client';

export function useSubmitDailyCheckin() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (payload: { logDate: string; exerciseCount: number }) => {
      const res = await apiClient.post('/api/checkin/submit', payload);
      return res.data;
    },
    // 1. Khi vừa bấm nút: Cập nhật giao diện NGAY LẬP TỨC (0ms latency)
    onMutate: async (newCheckin) => {
      // Hủy mọi query đang fetch dở để tránh ghi đè dữ liệu lạc quan
      await queryClient.cancelQueries({ queryKey: currentUserQueryKey });

      // Lưu lại snapshot dữ liệu cũ để rollback nếu gặp sự cố mạng
      const previousUser = queryClient.getQueryData<CurrentUser>(currentUserQueryKey);

      // Cập nhật tức thời vào cache
      if (previousUser) {
        queryClient.setQueryData<CurrentUser>(currentUserQueryKey, {
          ...previousUser,
          currentStreak: previousUser.currentStreak + 1,
          totalPoints: previousUser.totalPoints + 50,
        });
      }

      return { previousUser };
    },
    // 2. Nếu API báo lỗi: Tự động khôi phục dữ liệu gốc như chưa có gì xảy ra
    onError: (err, newCheckin, context) => {
      if (context?.previousUser) {
        queryClient.setQueryData(currentUserQueryKey, context.previousUser);
      }
    },
    // 3. Khi hoàn tất: Revalidate ngầm với backend để đảm bảo tính nhất quán tuyệt đối
    onSettled: () => {
      queryClient.invalidateQueries({ queryKey: currentUserQueryKey });
    },
  });
}
```

---

### Kết Quả Đo Đạc Sau Đại Phẫu Thuật

Cuộc di chuyển từ Redux sang TanStack Query + Zustand mang lại những con số kinh ngạc:

- **Dòng code loại bỏ (Lines of Code)**: Xóa sạch **6.420 dòng** boilerplate thừa thãi, thay bằng **285 dòng** mã nguồn mạch lạc.
- **Dung lượng JavaScript Bundle**: Giảm **44.8 KB** (Gzip), tăng tốc thời gian tải trang ban đầu.
- **Số lượng HTTP Request trùng lặp**: Giảm **100%** đối với các endpoint dùng chung (`/api/me`, `/api/notifications/count`).
- **Thời gian Render UI**: Loại bỏ hoàn toàn các đợt re-render thừa của Redux root provider, đưa chỉ số Interaction to Next Paint (INP) về mức hoàn hảo **18ms**.

---

### Liên Kết Chéo Ký Sự Thực Chiến (Kido Chronicles)

Để hiểu rõ hơn về bối cảnh thực tế, drama debug nghẹt thở và những câu chuyện "người thật việc thật" đằng sau các quyết định kỹ thuật này, bạn có thể thưởng thức các chương truyện tranh manga minh họa độc quyền tương ứng:

- 🎭 **Tập 61**: [Cơn ác mộng 4 request trùng lặp cùng lúc](https://truyen.khanhdp.com/tap/tap-61-con-ac-mong-4-request-trung-lap/) — Khoảnh khắc bàng hoàng khi mở Network tab thấy 4 kết nối đồng thời dội bom vào máy chủ NestJS.
- 🎭 **Tập 112**: [Cú nuốt chửng điểm số của Redux State Rollover](https://truyen.khanhdp.com/tap/tap-112-cu-nuot-chung-diem-so-cua-redux-state-rollover/) — Vụ án bóng ma dữ liệu cũ đội mồ sống dậy lúc nửa đêm xóa sạch thành quả của học viên.
- 🎭 **Tập 116**: [Đại phẫu thuật State Management: Zustand & TanStack Query](https://truyen.khanhdp.com/tap/tap-116-dai-phau-thuat-state-management-zustand-tanstack-query/) — Quyết định dũng cảm đập bỏ bức tường Redux già cỗi để kiến tạo nền móng tương lai.
- 🎭 **Tập 118**: [Cuộc khai tử 6.400 dòng Redux](https://truyen.khanhdp.com/tap/tap-118-cuoc-khai-tu-6400-dong-redux-cu-lat-do-the-ky-cua-zustand-tanstack-query/) — Cảm xúc vỡ òa khi nhấn nút commit xóa sổ hơn 6.000 dòng code phức tạp, đón nhận sự thanh thoát tuyệt đối.
