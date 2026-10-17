import SwiftUI

private enum Palette {
    static let background = Color(red: 0.973, green: 0.969, blue: 0.953)
    static let purple = Color(red: 0.50, green: 0.43, blue: 0.56)
    static let lavender = Color(red: 0.914, green: 0.882, blue: 0.941)
    static let ink = Color(red: 0.188, green: 0.208, blue: 0.176)
    static let green = Color(red: 0.40, green: 0.46, blue: 0.35)
}
private struct Card: ViewModifier {
    func body(content: Content) -> some View {
        content.padding(18).frame(maxWidth: .infinity, alignment: .leading)
            .background(.white, in: RoundedRectangle(cornerRadius: 22))
    }
}
private struct EditRequest: Identifiable {
    let id = UUID()
    let collection: String
    var record: PhoneRecord? = nil
    var seed = ""
}

struct ContentView: View {
    @StateObject private var cloud = PhoneCloud()
    @Environment(\.scenePhase) private var scenePhase
    @State private var tab = 0
    @State private var password = ""
    @State private var draft = ""
    @State private var edit: EditRequest?
    @State private var showToday = false
    @State private var showImage = false
    @State private var showSettings = false
    @FocusState private var composing: Bool

    var body: some View {
        Group {
            if cloud.signedIn {
                TabView(selection: $tab) {
                    page("此刻") { home }.tabItem { Label("此刻", systemImage: "house") }.tag(0)
                    page("短期计划") { records(plans: true) }.tabItem { Label("计划", systemImage: "calendar") }.tag(1)
                    page("长期记忆") { records(plans: false) }.tabItem { Label("记忆", systemImage: "sparkles") }.tag(2)
                    chat.tabItem { Label("对话", systemImage: "bubble.left.and.bubble.right") }.tag(3)
                }
            } else { login }
        }
        .tint(Palette.purple)
        .foregroundStyle(Palette.ink)
        .preferredColorScheme(.light)
        .task(id: scenePhase == .background) {
            if scenePhase == .background { cloud.pause(); return }
            await cloud.maintainConnection()
        }
        .sheet(item: $edit) { request in RecordEditor(cloud: cloud, request: request) }
        .sheet(isPresented: $showToday) { today }
        .sheet(isPresented: $showImage) { pictureDetail }
        .sheet(isPresented: $showSettings) { settings }
    }

    private var login: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 26) {
                    Label("Porchlight / 留灯", systemImage: "house.fill")
                        .font(.headline).foregroundStyle(Palette.green)
                    VStack(alignment: .leading, spacing: 14) {
                        Text("让生活，\n少一点打扰。")
                            .font(.system(.largeTitle, design: .rounded).weight(.semibold))
                        Text("连接 Homi，看看此刻的画面，\n把临时安排与日常习惯放在一起。")
                            .font(.body).foregroundStyle(.secondary)
                    }.padding(.vertical, 22)
                    VStack(alignment: .leading, spacing: 18) {
                        Label("连接你的留灯", systemImage: "lock.shield").font(.title3.weight(.medium))
                        SecureField("团队访问密码", text: $password)
                            .textContentType(.password).submitLabel(.go)
                            .padding(16).background(Palette.background, in: RoundedRectangle(cornerRadius: 14))
                            .onSubmit { signIn() }
                        Button(action: signIn) {
                            HStack { Spacer(); if cloud.busy { ProgressView() }; Text(cloud.busy ? "正在连接…" : "进入留灯"); Spacer() }
                                .frame(minHeight: 48)
                        }.buttonStyle(.borderedProminent).disabled(password.isEmpty || cloud.busy)
                        Button("重新检查云端连接") { Task { await cloud.connectIfAllowed() } }.disabled(cloud.busy)
                        Text("使用团队控制台的访问密码。本次登录凭证仅保存在内存中。")
                            .font(.footnote).foregroundStyle(.secondary)
                    }.modifier(Card())
                    errorNotice
                    Label("真实云端数据 · 摄像头关闭时仍可查看记录", systemImage: "cloud")
                        .font(.footnote).foregroundStyle(.secondary)
                }.padding(24).frame(maxWidth: 680)
                    .frame(maxWidth: .infinity)
            }.background(Palette.background).scrollDismissesKeyboard(.interactively)
        }
    }
    private func signIn() {
        guard !password.isEmpty, !cloud.busy else { return }
        let value = password; password = ""
        Task { await cloud.login(password: value) }
    }

    private func page<V: View>(_ title: String, @ViewBuilder content: () -> V) -> some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if !cloud.connected { Label(cloud.status, systemImage: "wifi.slash").font(.footnote).foregroundStyle(.secondary) }
                    errorNotice
                    content()
                }.padding(.horizontal, 22).padding(.vertical, 16)
                    .frame(maxWidth: 680).frame(maxWidth: .infinity)
            }
            .background(Palette.background)
            .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Label("留灯", systemImage: "house.fill").font(.headline).foregroundStyle(Palette.green)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button { showSettings = true } label: { Image(systemName: "ellipsis.circle").frame(width: 44, height: 44) }
                        .accessibilityLabel("连接设置")
                }
            }
        }
    }

    private var home: some View {
        VStack(alignment: .leading, spacing: 18) {
            VStack(alignment: .leading, spacing: 8) {
                Text("让生活，少一点打扰。")
                    .font(.system(.title2, design: .rounded).weight(.semibold))
                Text("看看此刻，或者告诉 Homi 你的安排。")
                    .font(.subheadline).foregroundStyle(.secondary)
            }
            Button { showImage = true } label: { picture }
                .buttonStyle(.plain).accessibilityLabel("查看摄像头截图")
            HStack(alignment: .top, spacing: 12) {
                Text("H").font(.headline).foregroundStyle(Palette.purple)
                    .frame(width: 38, height: 38).background(Palette.lavender, in: Circle())
                VStack(alignment: .leading, spacing: 5) {
                    Text("最近发生").font(.caption).foregroundStyle(.secondary)
                    Text(cloud.summary).font(.subheadline).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 0)
            }
            Button { tab = 3 } label: {
                HStack { Text("告诉 Homi"); Spacer(); Image(systemName: "arrow.up.right") }
                    .font(.subheadline.weight(.medium)).padding(15)
                    .background(Palette.lavender.opacity(0.65), in: RoundedRectangle(cornerRadius: 16))
            }
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 12) { shortcut(plans: true); shortcut(plans: false) }
                VStack(spacing: 12) { shortcut(plans: true); shortcut(plans: false) }
            }
            Button { showToday = true } label: {
                HStack { Label("今天的记录", systemImage: "clock"); Spacer(); Text("查看"); Image(systemName: "chevron.right") }
                    .font(.subheadline).frame(minHeight: 44)
            }
            if !cloud.alerts.isEmpty {
                Text("需要你看一眼").font(.headline)
                ForEach(cloud.alerts) { alert in
                    VStack(alignment: .leading, spacing: 12) {
                        Label(alert.text, systemImage: "bell.badge").font(.body)
                        Button("知道了") { Task { await cloud.dismiss(alert.id) } }
                            .buttonStyle(.bordered).disabled(cloud.busy || !cloud.connected)
                    }.modifier(Card())
                }
            }
        }
    }
    private func shortcut(plans: Bool) -> some View {
        Button { tab = plans ? 1 : 2 } label: {
            VStack(alignment: .leading, spacing: 12) {
                Image(systemName: plans ? "calendar" : "sparkles").font(.title2).foregroundStyle(Palette.green)
                Text(plans ? "短期计划" : "长期记忆").font(.headline)
                Text("\((plans ? cloud.planRecords : cloud.memories).filter(\.enabled).count) 条启用")
                    .font(.caption).foregroundStyle(.secondary)
            }.frame(minWidth: 120, maxWidth: .infinity, alignment: .leading).modifier(Card())
        }.buttonStyle(.plain)
    }
    private var picture: some View {
        VStack(spacing: 0) {
            ZStack {
                RoundedRectangle(cornerRadius: 0).fill(Palette.lavender.opacity(0.5))
                if let image = cloud.image {
                    Image(uiImage: image).resizable().scaledToFit()
                } else {
                    VStack(spacing: 12) {
                        Image(systemName: "camera").font(.largeTitle)
                        Text(cloud.connected ? "暂无摄像头画面" : "正在连接云端")
                            .font(.headline)
                        Text("采集开启后，画面会自动更新")
                            .font(.caption).foregroundStyle(.secondary)
                    }.padding()
                }
            }.aspectRatio(1.5, contentMode: .fit)
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(cloud.image == nil ? "摄像头截图" : (cloud.live && cloud.connected ? "最近接收的画面" : "历史画面 · 暂未更新"))
                        .font(.subheadline.weight(.medium))
                    if let date = cloud.imageDate { Text(date, style: .time).font(.caption).foregroundStyle(.secondary) }
                }
                Spacer()
                Image(systemName: "arrow.up.left.and.arrow.down.right").foregroundStyle(Palette.purple)
            }.padding(16).background(.white)
        }.clipShape(RoundedRectangle(cornerRadius: 24))
    }

    private func records(plans: Bool) -> some View {
        let list = plans ? cloud.planRecords : cloud.memories
        return VStack(alignment: .leading, spacing: 16) {
            Text(plans ? "时间变了，直接改卡片就好。" : "看看 Homi 怎样理解你的习惯，不准确就改掉。")
                .font(.subheadline).foregroundStyle(.secondary)
            Button { edit = EditRequest(collection: plans ? "plans" : "memories") } label: {
                Label(plans ? "新增计划" : "新增记忆", systemImage: "plus").frame(maxWidth: .infinity, minHeight: 48)
            }.buttonStyle(.borderedProminent).disabled(!cloud.connected || cloud.busy)
            if list.isEmpty { ContentUnavailableView(plans ? "还没有计划" : "还没有记忆", systemImage: plans ? "calendar" : "sparkles", description: Text("你确认保存的内容会同步到云端。")) }
            ForEach(list) { item in
                VStack(alignment: .leading, spacing: 14) {
                    Text(item.text).font(.body.weight(.medium))
                    Text(plans ? item.planState : (item.enabled ? "使用中" : "已暂停"))
                        .font(.caption.weight(.medium)).foregroundStyle(Palette.green)
                    if plans {
                        let start = Date(timeIntervalSince1970: (item.raw["start"] as? Double ?? 0) / 1000)
                        let end = Date(timeIntervalSince1970: (item.raw["end"] as? Double ?? 0) / 1000)
                        Text(start.formatted(date: .abbreviated, time: .shortened) + " — " + end.formatted(date: .abbreviated, time: .shortened))
                            .font(.footnote).foregroundStyle(.secondary)
                    }
                    ViewThatFits {
                        HStack { editButton(item, plans: plans); Spacer(); toggleButton(item, plans: plans) }
                        VStack(alignment: .leading) { editButton(item, plans: plans); toggleButton(item, plans: plans) }
                    }
                }.modifier(Card())
            }
        }
    }
    private func editButton(_ record: PhoneRecord, plans: Bool) -> some View {
        Button(plans ? "修改内容 / 时间" : "修改记忆") { edit = EditRequest(collection: plans ? "plans" : "memories", record: record) }
            .frame(minHeight: 44).disabled(cloud.busy || !cloud.connected)
    }
    private func toggleButton(_ record: PhoneRecord, plans: Bool) -> some View {
        Button(record.enabled ? (plans ? "结束计划" : "暂停使用") : "重新启用") {
            Task { _ = await cloud.saveRecord(collection: plans ? "plans" : "memories", id: record.id, fields: ["enabled": !record.enabled]) }
        }.frame(minHeight: 44).disabled(cloud.busy || !cloud.connected)
    }

    private var chat: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        Text("说一句话，再选择它要去哪里。")
                            .font(.subheadline).foregroundStyle(.secondary)
                        if cloud.messages.isEmpty {
                            VStack(alignment: .leading, spacing: 12) {
                                Text("你好，我是 Homi。").font(.title3.weight(.medium))
                                Text("你可以问我今天发生了什么，也可以写下一句安排，确认后存为计划或记忆。")
                                    .font(.body).foregroundStyle(.secondary)
                            }.modifier(Card())
                        }
                        ForEach(cloud.messages) { message in
                            HStack {
                                if message.role == "user" { Spacer(minLength: 32) }
                                Text(message.text).textSelection(.enabled).padding(16)
                                    .background(message.role == "user" ? Palette.lavender : .white, in: RoundedRectangle(cornerRadius: 20))
                                if message.role != "user" { Spacer(minLength: 32) }
                            }.id(message.id)
                        }
                        if cloud.chatting { ProgressView("Homi 正在查看记录…") }
                        errorNotice
                        Color.clear.frame(height: 1).id("end")
                    }.padding(22).frame(maxWidth: 680).frame(maxWidth: .infinity)
                }.scrollDismissesKeyboard(.interactively)
                    .onChange(of: cloud.messages.count) { _, _ in proxy.scrollTo("end", anchor: .bottom) }
                    .safeAreaInset(edge: .bottom) { composer }
                    .background(Palette.background)
            }
            .navigationTitle("告诉 Homi").navigationBarTitleDisplayMode(.inline)
        }
    }
    private var composer: some View {
        VStack(spacing: 10) {
            HStack(alignment: .bottom, spacing: 12) {
                TextField("例如：外卖到了告诉我", text: $draft, axis: .vertical)
                    .lineLimit(1...5).focused($composing).padding(14)
                    .background(Palette.background, in: RoundedRectangle(cornerRadius: 16))
                Button {
                    let text = draft; draft = ""; composing = false
                    Task { await cloud.sendChat(text) }
                } label: { Image(systemName: "arrow.up").font(.headline).frame(width: 48, height: 48) }
                    .buttonStyle(.borderedProminent).clipShape(Circle())
                    .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || cloud.chatting || !cloud.connected)
                    .accessibilityLabel("发送给 Homi")
            }
            HStack(spacing: 18) {
                Button("存为计划") { composing = false; edit = EditRequest(collection: "plans", seed: draft) }
                Button("存为记忆") { composing = false; edit = EditRequest(collection: "memories", seed: draft) }
                Spacer()
            }.font(.subheadline).frame(minHeight: 44).disabled(draft.isEmpty || !cloud.connected)
        }.padding(.horizontal, 22).padding(.top, 12).padding(.bottom, 8).background(.white)
    }

    private var today: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text(cloud.report).font(.title3).modifier(Card())
                    Button("生成今天的日报") { Task { await cloud.writeReport() } }
                        .buttonStyle(.bordered).disabled(cloud.busy || !cloud.connected)
                    errorNotice
                    let events = cloud.events.filter { Calendar.current.isDateInToday($0.date) }
                    if events.isEmpty { ContentUnavailableView("今天暂无事件", systemImage: "clock") }
                    ForEach(events) { event in
                        VStack(alignment: .leading, spacing: 10) {
                            Text(event.date, style: .time).font(.caption).foregroundStyle(.secondary)
                            Text(event.text).font(.body)
                            Text(event.raw["verdict"] as? String == "alert" ? "提醒" : (event.raw["verdict"] as? String == "notice" ? "留意" : "记录"))
                                .font(.caption).foregroundStyle(Palette.green)
                        }.modifier(Card())
                    }
                }.padding(22)
            }.background(Palette.background).navigationTitle("今天的记录")
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { showToday = false } } }
        }
    }
    private var pictureDetail: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    picture
                    Button { Task { await cloud.refreshImage() } } label: {
                        Label(cloud.busy ? "获取中…" : "现在看一眼", systemImage: "arrow.clockwise").frame(maxWidth: .infinity, minHeight: 48)
                    }.buttonStyle(.borderedProminent).disabled(cloud.busy || !cloud.connected)
                    errorNotice
                    Text("画面由电脑摄像头采集端上传，以截图方式更新。采集端关闭时，你仍然可以查看云端记录。")
                        .font(.footnote).foregroundStyle(.secondary)
                }.padding(22)
            }.background(Palette.background).navigationTitle("摄像头画面")
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { showImage = false } } }
        }
    }
    private var settings: some View {
        NavigationStack {
            List {
                Section("连接状态") {
                    Label(cloud.status, systemImage: cloud.connected ? "checkmark.circle" : "wifi.slash")
                    Text(cloud.live ? "采集端已开启" : "采集端未开启")
                }
                Section("当前版本") {
                    Text("iPhone 16 Pro Max · 紫白简洁版")
                    Text("与手表使用同一云端。后台暂停实时同步，回到前台自动重连。")
                    Text("语音输入可使用系统键盘听写。设备对讲、实时视频和锁屏推送尚未接入。")
                }
                Button("退出登录", role: .destructive) { cloud.logout(); draft = ""; showSettings = false }
            }.navigationTitle("留灯设置")
                .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { showSettings = false } } }
        }
    }
    @ViewBuilder private var errorNotice: some View {
        if !cloud.error.isEmpty {
            Label(cloud.error, systemImage: "exclamationmark.circle")
                .font(.footnote).foregroundStyle(.orange).padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color.orange.opacity(0.07), in: RoundedRectangle(cornerRadius: 12))
        }
    }
}

private struct RecordEditor: View {
    @ObservedObject var cloud: PhoneCloud
    let request: EditRequest
    @Environment(\.dismiss) private var dismiss
    @State private var text: String
    @State private var kind: String
    @State private var cues: String
    @State private var start: Date
    @State private var end: Date
    @State private var localError = ""
    private var isPlan: Bool { request.collection == "plans" }
    init(cloud: PhoneCloud, request: EditRequest) {
        self.cloud = cloud; self.request = request
        _text = State(initialValue: request.record?.text ?? request.seed)
        _kind = State(initialValue: request.record?.kind ?? "expect")
        _cues = State(initialValue: request.record?.raw["cues"] as? String ?? "")
        _start = State(initialValue: (request.record?.raw["start"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) } ?? Date())
        _end = State(initialValue: (request.record?.raw["end"] as? Double).map { Date(timeIntervalSince1970: $0 / 1000) } ?? Date().addingTimeInterval(3600))
    }
    var body: some View {
        NavigationStack {
            Form {
                Section("内容") {
                    TextEditor(text: $text).frame(minHeight: 110).accessibilityLabel("内容")
                }
                if isPlan {
                    Section("计划类型") {
                        Picker("类型", selection: $kind) {
                            Text("发生了提醒我").tag("expect")
                            Text("这段时间少提醒").tag("relax")
                            Text("需要遵守的安排").tag("rule")
                        }
                        if kind == "expect" { TextField("识别线索（可选）", text: $cues, axis: .vertical) }
                    }
                    Section("生效时间") {
                        DatePicker("开始", selection: $start)
                        DatePicker("结束", selection: $end)
                    }
                }
                Section {
                    Text("确认后保存到团队云端，其他已连接设备会同步更新。")
                        .font(.footnote).foregroundStyle(.secondary)
                    if !localError.isEmpty { Text(localError).foregroundStyle(.red) }
                    if !cloud.error.isEmpty { Text(cloud.error).foregroundStyle(.red) }
                    Button(cloud.busy ? "保存中…" : "确认保存") {
                        let value = text.trimmingCharacters(in: .whitespacesAndNewlines)
                        guard !value.isEmpty else { localError = "请填写内容"; return }
                        guard !isPlan || end > start else { localError = "结束时间需要晚于开始时间"; return }
                        localError = ""
                        var fields: [String: Any] = ["text": value]
                        if isPlan {
                            fields["kind"] = kind; fields["cues"] = cues
                            fields["start"] = start.timeIntervalSince1970 * 1000
                            fields["end"] = end.timeIntervalSince1970 * 1000
                        }
                        Task { if await cloud.saveRecord(collection: request.collection, id: request.record?.id, fields: fields) { dismiss() } }
                    }.disabled(cloud.busy || !cloud.connected).frame(minHeight: 44)
                }
            }.navigationTitle(isPlan ? "短期计划" : "长期记忆")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() }.disabled(cloud.busy) } }
        }.interactiveDismissDisabled(cloud.busy)
    }
}
