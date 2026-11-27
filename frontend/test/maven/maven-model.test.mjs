// maven-model.test.mjs —— Maven 工具窗口纯函数层：开关 / 命令拼装 / 依赖树与 XML 解析。

import test from 'node:test';
import assert from 'node:assert/strict';
import {XMLParser} from 'fast-xml-parser';
import {
    MAVEN_LIFECYCLE,
    MAVEN_FLAG_DEFS,
    mavenFlagsOrDefaults,
    mavenFlagArgs,
    splitGoalTokens,
    assembleMavenArgs,
    parseDependencyTreeText,
    parseEffectivePomPlugins,
    parseEffectiveSettings,
} from '../../src/maven/maven-model.js';

test('生命周期是固定九件套', () => {
    assert.deepEqual(MAVEN_LIFECYCLE,
        ['clean', 'validate', 'compile', 'test', 'package', 'verify', 'install', 'site', 'deploy']);
});

test('开关规整：缺省全关，未知 id 不进表', () => {
    assert.deepEqual(mavenFlagsOrDefaults({}), {
        offline: false, skipTests: false, updateSnapshots: false, noTransferProgress: false,
    });
    const flags = mavenFlagsOrDefaults({mavenFlags: {offline: true, skipTests: 1, bogus: true}});
    assert.equal(flags.offline, true);
    assert.equal(flags.skipTests, true);
    assert.equal(flags.bogus, undefined);
    assert.equal(flags.updateSnapshots, false);
});

test('开关按固定顺序拼参数', () => {
    assert.deepEqual(mavenFlagArgs({skipTests: true, offline: true}), ['-o', '-DskipTests']);
    assert.deepEqual(mavenFlagArgs({}), []);
    assert.deepEqual(mavenFlagArgs({noTransferProgress: true}), ['-ntp']);
});

test('splitGoalTokens：正常词元通过，cmd 元字符拒绝', () => {
    assert.deepEqual(splitGoalTokens('clean package -DskipTests'), ['clean', 'package', '-DskipTests']);
    assert.deepEqual(splitGoalTokens('org.example:plugin:1.0:go'), ['org.example:plugin:1.0:go']);
    for (const bad of ['a&b', 'x|y', 'a>b', '^x', '%PATH%', 'a"b', "a'b", 'a;b']) {
        assert.throws(() => splitGoalTokens(bad), undefined, bad + ' 应被拒绝');
    }
    assert.deepEqual(splitGoalTokens('  '), [], '空输入给空数组（空 goal 在拼装层拒绝）');
});

test('assembleMavenArgs：开关 + 模块 + goal 的完整拼装', () => {
    const args = assembleMavenArgs({
        flags: {offline: true},
        moduleRelPath: 'sky-admin',
        goal: 'compile',
    });
    assert.deepEqual(args, ['-o', '-pl', 'sky-admin', 'compile']);
});

test('assembleMavenArgs：无模块时不出 -pl', () => {
    const args = assembleMavenArgs({flags: {}, goal: 'clean package'});
    assert.deepEqual(args, ['clean', 'package']);
});

test('assembleMavenArgs：模块路径越界与空 goal 拒绝', () => {
    assert.throws(() => assembleMavenArgs({goal: 'compile', moduleRelPath: '../escape'}));
    assert.throws(() => assembleMavenArgs({goal: 'compile', moduleRelPath: 'C:/x'}));
    assert.throws(() => assembleMavenArgs({goal: 'compile', moduleRelPath: '..\\escape'})); // 反斜杠穿越（L5）
    assert.throws(() => assembleMavenArgs({goal: 'compile', moduleRelPath: 'a\\b'})); // 反斜杠分隔（L5）
    assert.throws(() => assembleMavenArgs({flags: {}, goal: ''}));
    // cmd 元字符注入面：relPath 来自不可信 pom 的 <module> 原文，与 goal 词元同一道防线——
    // Windows 上命令外层是 cmd /c，& | < > ^ % ! 会被 cmd 再解释
    for (const bad of ['foo&bar', 'a|b', 'x>y', 'a<b', '%VAR%', 'a^b', 'a!b', 'a b', 'a;b']) {
        assert.throws(() => assembleMavenArgs({goal: 'compile', moduleRelPath: bad}), undefined, bad + ' 应被拒绝');
    }
});

test('parseDependencyTreeText：带 [INFO] 前缀与尾注的完整树', () => {
    const text = [
        '[INFO] --- maven-dependency-plugin:3.6.1:tree (default-cli) @ app ---',
        '[INFO] com.example:app:jar:1.0.0',
        '[INFO] +- org.slf4j:slf4j-api:jar:1.7.36:compile',
        '[INFO] |  \\- ch.qos.logback:logback-classic:jar:1.2.13:runtime (omitted for duplicate)',
        '[INFO] +- junit:junit:jar:4.13.2:test',
        '[INFO] \\- org.example:deep:jar:2.0:compile',
        '[INFO]    +- org.example:leaf-a:jar:1.0:compile',
        '[INFO]    \\- org.example:leaf-b:jar:1.0:runtime',
    ].join('\n');
    const roots = parseDependencyTreeText(text);
    assert.equal(roots.length, 1);
    const root = roots[0];
    assert.equal(root.label, 'com.example:app:jar:1.0.0');
    assert.equal(root.scope, '');
    assert.equal(root.children.length, 3);
    const slf4j = root.children[0];
    assert.equal(slf4j.label, 'org.slf4j:slf4j-api:jar:1.7.36:compile');
    assert.equal(slf4j.scope, 'compile');
    assert.equal(slf4j.children.length, 1);
    assert.equal(slf4j.children[0].label, 'ch.qos.logback:logback-classic:jar:1.2.13:runtime');
    assert.equal(slf4j.children[0].scope, 'runtime');
    const deep = root.children[2];
    assert.equal(deep.children.length, 2);
    assert.equal(deep.children[0].label, 'org.example:leaf-a:jar:1.0:compile');
});

test('parseDependencyTreeText：-DoutputFile 纯文本形态', () => {
    const text = [
        'com.example:app:jar:1.0.0',
        '+- org.slf4j:slf4j-api:jar:1.7.36:compile',
        '\\- junit:junit:jar:4.13.2:test',
    ].join('\n');
    const roots = parseDependencyTreeText(text);
    assert.equal(roots.length, 1);
    assert.equal(roots[0].children.length, 2);
});

test('parseDependencyTreeText：多层嵌套 + version managed 尾注', () => {
    const text = [
        'com.example:app:jar:1.0.0',
        '+- org.springframework:spring-core:jar:6.1.0:compile',
        '|  +- org.springframework:spring-jcl:jar:6.1.0:compile (version managed from 5.3.0)',
        '|  \\- commons-logging:commons-logging:jar:1.2:compile (omitted for duplicate)',
        '\\- junit:junit:jar:4.13.2:test',
    ].join('\n');
    const roots = parseDependencyTreeText(text);
    assert.equal(roots.length, 1);
    const root = roots[0];
    assert.equal(root.children.length, 2);
    const spring = root.children[0];
    assert.equal(spring.children.length, 2);
    assert.equal(spring.children[0].label, 'org.springframework:spring-jcl:jar:6.1.0:compile');
    assert.equal(spring.children[1].label, 'commons-logging:commons-logging:jar:1.2:compile');
    assert.equal(root.children[1].label, 'junit:junit:jar:4.13.2:test');
});

test('parseDependencyTreeText：空与垃圾输入', () => {
    assert.deepEqual(parseDependencyTreeText(''), []);
    assert.deepEqual(parseDependencyTreeText(null), []);
    assert.deepEqual(parseDependencyTreeText('=== build log noise ===\n'), []);
});

test('parseEffectivePomPlugins：取 build/plugins 下的生效插件', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <artifactId>app</artifactId>
  <build>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-compiler-plugin</artifactId>
        <version>3.13.0</version>
      </plugin>
      <plugin>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-maven-plugin</artifactId>
      </plugin>
    </plugins>
  </build>
</project>`;
    const plugins = parseEffectivePomPlugins(xml);
    assert.equal(plugins.length, 2);
    assert.equal(plugins[0].artifactId, 'maven-compiler-plugin');
    assert.equal(plugins[0].version, '3.13.0');
    assert.equal(plugins[1].artifactId, 'spring-boot-maven-plugin');
    assert.equal(plugins[1].version, '');
});

test('parseEffectivePomPlugins：无插件 / 垃圾输入', () => {
    assert.deepEqual(parseEffectivePomPlugins('<project><build></build></project>'), []);
    assert.deepEqual(parseEffectivePomPlugins('<project/>'), []);
    assert.throws(() => parseEffectivePomPlugins('not xml at all <'));
});

// 聚合根上 help:effective-pom 按 reactor 输出多个 <project>，fast-xml-parser 收成数组——
// 只取第一个根（根项目的插件），不能因为取不到 build 而返回空。
test('parseEffectivePomPlugins：多根 reactor 输出取第一个根', () => {
    const dualRoot = `<project><artifactId>root</artifactId><build><plugins><plugin><groupId>g</groupId><artifactId>root-plugin</artifactId></plugin></plugins></build></project>
<project><artifactId>mod-a</artifactId><build><plugins><plugin><groupId>g</groupId><artifactId>mod-plugin</artifactId></plugin></plugins></build></project>`;
    // 先实证双根在 fast-xml-parser 下确实是数组（这是修复的前提事实）
    const doc = new XMLParser({ignoreAttributes: true, parseTagValue: false, trimValues: true}).parse(dualRoot);
    assert.ok(Array.isArray(doc.project), '双根应解析为 project 数组');
    const plugins = parseEffectivePomPlugins(dualRoot);
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0].artifactId, 'root-plugin');
});

test('parseEffectiveSettings：本地仓库 + 镜像 + profile 仓库', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<settings xmlns="http://maven.apache.org/SETTINGS/1.2.0">
  <localRepository>D:/repo/m2</localRepository>
  <mirrors>
    <mirror>
      <id>aliyun</id>
      <url>https://maven.aliyun.com/repository/public</url>
      <mirrorOf>central</mirrorOf>
    </mirror>
  </mirrors>
  <profiles>
    <profile>
      <id>corp</id>
      <repositories>
        <repository>
          <id>internal</id>
          <url>https://nexus.corp/repo</url>
        </repository>
        <repository>
          <id>second</id>
          <url>https://nexus.corp/second</url>
        </repository>
      </repositories>
    </profile>
  </profiles>
</settings>`;
    const settings = parseEffectiveSettings(xml);
    assert.equal(settings.localRepository, 'D:/repo/m2');
    assert.deepEqual(settings.mirrors, [{
        id: 'aliyun',
        url: 'https://maven.aliyun.com/repository/public',
        mirrorOf: 'central',
    }]);
    assert.equal(settings.repositories.length, 2);
    assert.equal(settings.repositories[0].id, 'internal');
});

test('parseEffectiveSettings：顶层仓库 + profile 仓库都收，按 id|url 去重', () => {
    const xml = `<settings>
      <repositories>
        <repository><id>root-repo</id><url>https://root/repo</url></repository>
      </repositories>
      <profiles><profile>
        <repositories>
          <repository><id>root-repo</id><url>https://root/repo</url></repository>
          <repository><id>profile-repo</id><url>https://profile/repo</url></repository>
        </repositories>
      </profile></profiles>
    </settings>`;
    const settings = parseEffectiveSettings(xml);
    assert.equal(settings.repositories.length, 2);
    assert.deepEqual(settings.repositories.map((r) => r.id), ['root-repo', 'profile-repo']);
});

test('parseEffectiveSettings：多根输出取第一个根', () => {
    const dualRoot = `<settings><localRepository>/first</localRepository></settings>
<settings><localRepository>/second</localRepository></settings>`;
    const settings = parseEffectiveSettings(dualRoot);
    assert.equal(settings.localRepository, '/first');
});

test('parseEffectiveSettings：缺段落回退空结构', () => {
    const settings = parseEffectiveSettings('<settings><localRepository>/x</localRepository></settings>');
    assert.equal(settings.localRepository, '/x');
    assert.deepEqual(settings.mirrors, []);
    assert.deepEqual(settings.repositories, []);
});

test('开关定义与生命周期表是配套的静态数据', () => {
    for (const def of MAVEN_FLAG_DEFS) {
        assert.match(def.arg, /^-[A-Za-z]/);
        assert.ok(def.label);
    }
});
