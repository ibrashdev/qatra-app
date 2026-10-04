# قطرة غيث — الوثائق الجارية

الإصدار ١٣ · ٤ أكتوبر ٢٠٢٦ · Asia/Dubai. الجذر qatra-app؛ وثائق ومراجع ضرورية فقط. القرارات المعتمدة تتقدم على التصميم المقترح والصور. الحالات: Approved للقرار المحدد، Needs Input للمتطلب غير المحسوم، Needs Review للتصميم المعد، Implemented/Verified لا تستعملان دون العمل ودليله.

| ابدأ بالوثيقة | الغرض |
|---|---|
| [Decision-register.md](Decision-register.md) | القرارات الثابتة D01–D65 وأثر القرارات الأحدث |
| [Readiness.tracker.md](Readiness.tracker.md) | حالات الاعتماد والأسئلة المتبقية والإجراء التالي |
| [Programming-guide.md](Programming-guide.md) | خريطة المهمة إلى الوثائق والملفات المخططة؛ بداية أي مهمة برمجية |
| [PRD.md](PRD.md) | النطاق والمتطلبات ومعايير القبول |
| [UX.md](UX.md) | الشاشات والرحلات والحالات |
| [Design-system.md](Design-system.md) | الهوية والألوان وقواعد الوضوح والصور المرجعية |
| [Architecture-and-data.md](Architecture-and-data.md) | البيانات والحدود والخطط وعقود API |
| [Authentication-and-privacy.md](Authentication-and-privacy.md) | الحساب والاسترجاع والبيانات وشروط الاستخدام |
| [Content-and-sources.md](Content-and-sources.md) | النص والطبعات والصفحات والحقوق وسير الإعداد |
| [Source-acquisition.md](Source-acquisition.md) | مراجعة المرجعية الموسعة وخادم MCP، ومرشحو جزء عم والأربعين، وأدلة الاتصال والحقوق والصفحات قبل الاستيراد |
| [Question-bank-rules.proposal.md](Question-bank-rules.proposal.md) | مقترح Needs Review لقواعد القرآن والحديث والفقه والعبادات ودور AI ومراجعة مدير المحتوى؛ لا يغير القرارات المعتمدة قبل اعتماد المالك |
| [AI-agent.md](AI-agent.md) | المخطط المقيد والمجاني ومحرك القواعد |
| [PWA-design.md](PWA-design.md) | التثبيت والخطة المحملة والمزامنة والتحديث |
| [QA-and-evaluation.md](QA-and-evaluation.md) | معايير قبول مستقبلية وسيناريوهات اصطناعية |
| [Qatra-build-plan.md](Qatra-build-plan.md) | هدف النسخة الأساسية يوم ٥ ويوم ٦ للتحقق |
| [Competition-alignment.md](Competition-alignment.md) | متطلبات التحدي وأدلتها وحدود المطابقة |
| [Delivery-and-baseline.md](Delivery-and-baseline.md) | شروط الجاهزية والتوثيق والتسليم |
| [Additional-features.md](Additional-features.md) | حد النطاق للميزات المؤجلة والمشروطة |

المراجع الضرورية: [دليل التحدي](../challenge/README.md#challenge-guide)، [المرجعية العلمية](../challenge/README.md#scientific-source-reference)، [سجل استشهاد الشروط](../references/terms-citation.md). صور Design-system داخل visuals/ مراجع بصرية محفوظة دون تغيير؛ تتقدم عليها المتطلبات والقرارات.

الحفظ يحتاج تغطية المقطع كاملًا عبر الأجزاء المستهدفة بالأسئلة ومراجعات الأيام ١/٣/٧ بعد الشرط الأولي (D41، D56، D64). الاختيار يشمل كلمة أو جزءًا، والترتيب يغطي أجزاء أكبر، والألعاب ذات الكلمة الواحدة تستهدف مواضع مفتاحية واستكمال؛ لا بنك ضخم متكرر أو عدد أسئلة ثابت، ولا تساوي التغطية نسبة نجاح الإجابات أو شهادة حفظ حرفي كامل. تصميم أدلة التغطية والجولات Needs Review؛ تجميع أهداف الحفظ ونسبة الإنجاز وأثر إخفاق لاحق Needs Input. المصدر الديني يبقى حرفيًا كاملًا. الدخول والخطط الجديدة والمزامنة تحتاج الشبكة؛ العمل المحمل يكشف حدود الخصوصية والسحب. AI مجاني فقط. جميع ملفات التطبيق في دليل البرمجة Planned، وتنفيذها ونشرها يخضعان لبوابات الاعتماد.

الحزمة التقنية وفق D36/D65: Next.js/TypeScript على Vercel، وFastAPI/Python على Render، وSupabase لـ PostgreSQL وAuth وStorage وpgvector. إعداد المحتوى سير عمل خلفي قابل للاستئناف؛ وكيل التعليم يبني ويعدل الخطة من المحتوى المنشور وتقدم المتعلم وفق D17/D38. تتبع رموز وتكلفة AI والتضمين مع الحصص المجانية وميزانية الصفر وفق D60. قاعدة اختيار نماذج التطوير في [AGENTS.md](../AGENTS.md): المنسق الكبير للتخطيط والقرارات، والوكلاء الأصغر للمهام الصغيرة والكتابة البرمجية.
