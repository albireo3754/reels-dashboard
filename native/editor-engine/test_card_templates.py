import unittest
from card_templates import render_template

class CardTemplateTests(unittest.TestCase):
    def test_same_role_uses_same_size_spacing_and_tracking(self):
        _,layers=render_template({'templateId':'body','text':'첫 번째 문장이에요.\n두 번째 문장이에요.\n세 번째 문장이에요.'})
        self.assertEqual({l['size'] for l in layers},{78})
        self.assertEqual({l['tracking'] for l in layers},{0})
        self.assertEqual([b['y']-a['y'] for a,b in zip(layers,layers[1:])],[117,117])
    def test_reject_custom_style_and_overflow(self):
        for extra in [{'fontSize':50},{'lineSizes':[30,40]},{'x':100},{'tracking':5}]:
            with self.assertRaises(ValueError):render_template({'templateId':'body','text':'문장',**extra})
        with self.assertRaises(ValueError):render_template({'templateId':'body','text':'긴문장'*50})
    def test_templates_have_separate_semantic_roles(self):
        _,layers=render_template({'templateId':'summary','text':'11월 1일 발권분부터\n유류할증료가\n올라요.'})
        self.assertEqual({l['size'] for l in layers},{98})
        im,layers=render_template({'templateId':'comparison','text':'가격 비교','table':{'columns':['항목','이전','이후'],'rows':[['항목 A','10','20'],['항목 B','20','30']]}})
        self.assertEqual(im.size,(1080,1920))
        self.assertEqual({l['size'] for l in layers[4:] if 'size' in l},{46})
    def test_follow_uses_fixed_signature_and_cta(self):
        im,layers=render_template({'templateId':'follow','text':'다음 정보도\n보고 싶다면','signature':'@sample 🌹'})
        self.assertEqual({l['size'] for l in layers},{78})
        self.assertEqual(im.size,(1080,1920))

    def test_line_height_ratio_is_shared_across_templates(self):
        for template in ['hook','body','summary','follow']:
            _,layers=render_template({'templateId':template,'text':'가나다 테스트\nABC gjpq'})
            self.assertEqual(layers[1]['y']-layers[0]['y'],round(layers[0]['size']*1.5))

    def test_table_caption_gaps_follow_actual_table_height(self):
        for count in [1,5,10]:
            _,layers=render_template({'templateId':'comparison','text':'가격 비교','table':{'columns':['항공사','10월','11월'],'rows':[['예시','10','20']]*count},'notes':'한국 출발 편도 기준'})
            table=next(l for l in layers if l.get('role')=='table')
            self.assertEqual(table['top']-(layers[0]['y']+layers[0]['height']),40)
            self.assertEqual(layers[-1]['y']-table['bottom'],32)
            self.assertLess(layers[-1]['y']+layers[-1]['height'],1780)

    def test_body_notes_follow_final_line(self):
        for text in ['한 줄','첫 줄\n두 번째 줄\n마지막 줄']:
            _,layers=render_template({'templateId':'body','text':text,'notes':'작은 설명'})
            self.assertEqual(layers[-1]['y']-layers[-2]['y']-layers[-2]['height'],32)
