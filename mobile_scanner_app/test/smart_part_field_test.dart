import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:daksh_mobile_scanner/widgets/smart_part_field.dart';

const part = {
  'partNumber': '20K211S',
  'partDescription': 'CHAIN SPROCKET TEST',
  'mrp': 770
};

void main() {
  Future<TextEditingController> mount(
      WidgetTester tester, Future<List<PartSuggestion>> Function(String) search,
      {ValueChanged<PartSuggestion>? onSelected, String scope = 'D1'}) async {
    final controller = TextEditingController();
    await tester.pumpWidget(MaterialApp(
        home: Scaffold(
            body: SizedBox(
                width: 400,
                child: SmartPartField(
                    controller: controller,
                    scopeKey: scope,
                    search: search,
                    onSelected: onSelected ?? (_) {})))));
    await tester.pump();
    return controller;
  }

  testWidgets(
      '200ms debounce and touch selection populate details without submitting',
      (tester) async {
    final queries = <String>[];
    var selections = 0;
    final controller = await mount(tester, (query) async {
      queries.add(query);
      return [part];
    }, onSelected: (_) => selections++);
    await tester.enterText(find.byType(TextField), '20');
    await tester.pump(const Duration(milliseconds: 100));
    await tester.enterText(find.byType(TextField), '20k');
    await tester.pump(const Duration(milliseconds: 199));
    expect(queries, isEmpty);
    await tester.pump(const Duration(milliseconds: 1));
    await tester.pump();
    expect(queries, ['20K']);
    expect(find.text('20K211S'), findsOneWidget);
    expect(find.textContaining('CHAIN SPROCKET TEST'), findsOneWidget);
    expect(find.textContaining('770'), findsNothing);
    await tester.tap(find.text('20K211S'));
    await tester.pump();
    expect(controller.text, '20K211S');
    expect(selections, 1);
    expect(find.text('20K211S'), findsNothing);
    expect(find.textContaining('CHAIN SPROCKET TEST'), findsNothing);
    expect(find.textContaining('770'), findsNothing);
    expect(tester.testTextInput.isVisible, true);
  });

  testWidgets(
      'older response cannot replace a newer query, including identical query reuse',
      (tester) async {
    final pending = <Completer<List<PartSuggestion>>>[];
    await mount(tester, (_) {
      final next = Completer<List<PartSuggestion>>();
      pending.add(next);
      return next.future;
    });
    for (final query in ['20K', '20K2', '20K']) {
      await tester.enterText(find.byType(TextField), query);
      await tester.pump(const Duration(milliseconds: 200));
    }
    pending[2].complete([part]);
    await tester.pump();
    pending[0].complete([
      {'partNumber': 'OLD'}
    ]);
    pending[1].complete([
      {'partNumber': 'OLDER'}
    ]);
    await tester.pump();
    expect(find.text('20K211S'), findsOneWidget);
    expect(find.text('OLD'), findsNothing);
    expect(find.text('OLDER'), findsNothing);
  });

  testWidgets('clearing and selection invalidate outstanding requests',
      (tester) async {
    final pending = Completer<List<PartSuggestion>>();
    await mount(tester, (_) => pending.future);
    await tester.enterText(find.byType(TextField), '20K');
    await tester.pump(const Duration(milliseconds: 200));
    await tester.enterText(find.byType(TextField), '');
    pending.complete([part]);
    await tester.pump();
    expect(find.text('20K211S'), findsNothing);
  });

  testWidgets('network failure leaves the input usable and retry succeeds',
      (tester) async {
    var calls = 0;
    final controller = await mount(tester, (_) async {
      if (++calls == 1) throw Exception('offline');
      return [part];
    });
    await tester.enterText(find.byType(TextField), '20K');
    await tester.pump(const Duration(milliseconds: 200));
    await tester.pump();
    expect(find.textContaining('Suggestions unavailable'), findsOneWidget);
    expect(controller.text, '20K');
    await tester.enterText(find.byType(TextField), '20K2');
    await tester.pump(const Duration(milliseconds: 200));
    await tester.pump();
    expect(find.text('20K211S'), findsOneWidget);
  });

  testWidgets(
      'suggestions do not intercept scanner Enter without explicit navigation',
      (tester) async {
    var selected = 0;
    await mount(tester, (_) async => [part], onSelected: (_) => selected++);
    await tester.enterText(find.byType(TextField), '20K');
    await tester.pump(const Duration(milliseconds: 200));
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    expect(selected, 0);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(selected, 1);
  });

  testWidgets(
      'small screen and visible keyboard retain a bounded touch dropdown',
      (tester) async {
    await tester.binding.setSurfaceSize(const Size(390, 740));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await mount(
        tester,
        (_) async =>
            List.generate(10, (index) => {...part, 'partNumber': '20K$index'}));
    await tester.enterText(find.byType(TextField), '20K');
    await tester.pump(const Duration(milliseconds: 200));
    await tester.pump();
    expect(tester.takeException(), isNull);
    final inputBottom = tester.getBottomLeft(find.byType(TextField)).dy;
    expect(tester.getTopLeft(find.byType(ListView)).dy,
        greaterThanOrEqualTo(inputBottom));
  });
}
