import SwiftUI

struct ContentView: View {
    @StateObject private var cloud = CloudModel()
    @State private var password = ""
    @State private var showImage = false
    @Environment(\.scenePhase) private var scenePhase
    private let purple = Color(red: 0.66, green: 0.55, blue: 0.95)

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("留灯").font(.headline)
                    Spacer()
                    Circle().fill(cloud.connected ? Color.green : Color.gray).frame(width: 7, height: 7)
                }
                if cloud.signedIn {
                    Text(cloud.status).font(.caption2).foregroundStyle(.secondary)
                    Button { showImage = true } label: { picture }
                        .buttonStyle(.plain)
                    Text("最近事件").font(.caption).foregroundStyle(purple)
                    Text(cloud.summary).font(.subheadline)
                    Text("提醒 · \(cloud.alerts.count)").font(.headline)
                    if cloud.alerts.isEmpty {
                        Text(cloud.connected ? "当前没有待处理提醒" : "等待同步提醒").font(.caption)
                    }
                    ForEach(cloud.alerts) { alert in
                        VStack(alignment: .leading, spacing: 8) {
                            Text(alert.text).font(.subheadline)
                            Button("知道了") { Task { await cloud.dismiss(alert.id) } }
                                .disabled(cloud.busy || !cloud.connected)
                        }
                        .padding(10)
                        .background(purple.opacity(0.12), in: RoundedRectangle(cornerRadius: 12))
                    }
                    Text("启用的计划").font(.headline)
                    if cloud.plans.isEmpty { Text("暂无计划").font(.caption).foregroundStyle(.secondary) }
                    ForEach(cloud.plans) { plan in Text(plan.text).font(.caption).padding(.vertical, 4) }
                    Text("前台同步；锁屏后暂停连接").font(.caption2).foregroundStyle(.secondary)
                    Button("退出登录") { password = ""; cloud.logout() }.font(.caption)
                } else {
                    Text("连接 Homi 云端").font(.headline)
                    Text("输入团队访问密码，查看真实画面和提醒。").font(.caption).foregroundStyle(.secondary)
                    SecureField("访问密码", text: $password)
                    Button(cloud.busy ? "登录中…" : "登录") {
                        let input = password; password = ""
                        Task { await cloud.login(password: input) }
                    }.disabled(password.isEmpty || cloud.busy)
                    Button("重新连接") { Task { await cloud.connectIfAllowed() } }.disabled(cloud.busy)
                    Text("密码和登录凭证仅用于本次运行，不保存到设备。").font(.caption2).foregroundStyle(.secondary)
                }
                if !cloud.error.isEmpty { Text(cloud.error).font(.caption2).foregroundStyle(.orange) }
            }.padding(.horizontal, 10).padding(.bottom, 12)
        }
        .tint(purple)
        .task(id: scenePhase == .background) {
            if scenePhase == .background { cloud.pause(); return }
            await cloud.maintainConnection()
        }
        .sheet(isPresented: $showImage) {
            ScrollView {
                VStack(spacing: 12) {
                    Text("摄像头画面").font(.headline)
                    picture
                    Button(cloud.busy ? "获取中…" : "现在看一眼") { Task { await cloud.refreshImage() } }
                        .disabled(cloud.busy || !cloud.connected)
                    if !cloud.error.isEmpty { Text(cloud.error).font(.caption2).foregroundStyle(.orange) }
                    Text("由电脑采集端提供截图，并非实时视频。").font(.caption2).foregroundStyle(.secondary)
                    Button("返回") { showImage = false }
                }.padding(10)
            }.tint(purple)
        }
    }

    private var picture: some View {
        VStack(spacing: 6) {
            if let image = cloud.image {
                Image(uiImage: image).resizable().scaledToFit().clipShape(RoundedRectangle(cornerRadius: 12))
                Text(cloud.connected && cloud.live ? "最近接收的画面" : "历史画面 · 当前未更新").font(.caption2)
                if let date = cloud.imageDate { Text(date, style: .time).font(.caption2).foregroundStyle(.secondary) }
            } else {
                Image(systemName: "camera").font(.title2)
                Text(cloud.connected ? "暂无画面" : "等待连接").font(.caption)
                Text("需在电脑开启摄像头采集").font(.caption2)
            }
        }
        .frame(maxWidth: .infinity).padding(8)
        .background(purple.opacity(0.12), in: RoundedRectangle(cornerRadius: 14))
    }
}
